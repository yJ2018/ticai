import { createHash } from 'node:crypto'

import { finishRun, startRun, withTransaction } from '../db.mjs'
import { sleep } from '../http.mjs'
import { parseInjuryEntries, parseResultEntries } from '../normalize.mjs'
import { MATCH_FEEDS, fetchMatchFeed } from '../sporttery.mjs'

/**
 * 对战数据：伤停为主（--full 时把 7 个源全抓）。
 *
 * 一个比赛 2~7 个请求，比在售赛程贵得多，所以不做全量轮询：
 * 只挑"开赛时间离现在最近"的一批比赛（默认 10 场），由调度器低频或按需触发。
 *
 * 2026-10 起「赛果」不再走这里：官网赛果开奖接口一次能拿一整天的比分，
 * 由 tasks/results.mjs 统一入库，这里的默认 feed 只剩伤停（请求数减半）。
 */

const UPSERT_FEED = `
  insert into match_feed (sporttery_match_id, feed, payload, content_hash, fetched_at)
  values ($1, $2, $3, $4, now())
  on conflict (sporttery_match_id, feed) do update set
    payload = excluded.payload,
    content_hash = excluded.content_hash,
    fetched_at = now()
`

const UPDATE_RESULT = `
  update match set
    home_score       = $2,
    away_score       = $3,
    home_half_score  = $4,
    away_half_score  = $5,
    status           = 'finished',
    result_status    = 'finished',
    result_source    = 'sporttery',
    result_at        = now(),
    updated_at       = now()
  where sporttery_match_id = $1
    and (home_score is distinct from $2
      or away_score is distinct from $3
      or home_half_score is distinct from $4
      or away_half_score is distinct from $5)
`

export async function storeFeed(pool, sportteryMatchId, feed, payload) {
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  await pool.query(UPSERT_FEED, [sportteryMatchId, feed, payload, hash])
}

/** 赛果里能对上本地库的比赛才更新；对不上（非竞彩赛事）自然忽略。 */
export async function applyResults(pool, entries) {
  let changed = 0
  for (const entry of entries) {
    const { rowCount } = await pool.query(UPDATE_RESULT, [
      entry.sportteryMatchId,
      entry.homeScore,
      entry.awayScore,
      entry.homeHalfScore,
      entry.awayHalfScore,
    ])
    changed += rowCount ?? 0
  }
  return changed
}

/**
 * 伤停落库：
 * 1. 球员按 `sporttery_person_id` upsert（不靠姓名匹配）；
 * 2. 伤停按 `source_ref = sporttery:<personId>` upsert，同一人只保留一条未愈记录；
 * 3. 本次名单里没出现的，视为已恢复，`ended_on` 置当天。
 *
 * @param {Array<{teamSportteryId:number, side:string}>} teams 本次拿到 block 的球队（含 0 人的）
 */
export async function applyInjuries(pool, { teams, entries }, log = console.log) {
  const byTeam = new Map()
  for (const team of teams) {
    if (Number.isFinite(team.teamSportteryId)) {
      byTeam.set(team.teamSportteryId, [])
    }
  }
  for (const entry of entries) {
    if (entry.teamSportteryId && byTeam.has(entry.teamSportteryId)) {
      byTeam.get(entry.teamSportteryId).push(entry)
    }
  }

  let saved = 0

  for (const [teamSportteryId, list] of byTeam) {
    await withTransaction(pool, async (client) => {
      const { rows: teamRows } = await client.query(
        'select id from team where sporttery_id = $1',
        [teamSportteryId],
      )
      if (teamRows.length === 0) {
        log(`  ! 未知球队 ${teamSportteryId}，跳过伤停`)
        return
      }
      const teamId = teamRows[0].id
      const refs = []

      for (const entry of list) {
        const { rows } = await client.query(
          `insert into player (sporttery_person_id, team_id, name, position, shirt_no, updated_at)
           values ($1, $2, $3, $4, $5, now())
           on conflict (sporttery_person_id) do update set
             team_id   = excluded.team_id,
             name      = excluded.name,
             position  = excluded.position,
             shirt_no  = excluded.shirt_no,
             updated_at = now()
           returning id`,
          [entry.personId, teamId, entry.name, entry.position, entry.uniformNo],
        )

        const playerId = rows[0].id
        const ref = `sporttery:${entry.personId}`
        refs.push(ref)

        await client.query(
          `insert into injury (player_id, team_id, status, injury_type, source, source_ref, reported_at, raw)
           values ($1, $2, 'out', $3, 'sporttery', $4, now(), $5)
           on conflict (source, source_ref) do update set
             player_id   = excluded.player_id,
             team_id     = excluded.team_id,
             injury_type = excluded.injury_type,
             status      = 'out',
             ended_on    = null,
             reported_at = now(),
             raw         = excluded.raw`,
          [playerId, teamId, entry.kind, ref, entry.raw],
        )
        saved += 1
      }

      // 名单里没有的一律视为已恢复（只对本次确实拿到数据的球队生效）
      await client.query(
        `update injury set ended_on = current_date
         where team_id = $1 and source = 'sporttery' and ended_on is null
           and source_ref <> all($2::text[])`,
        [teamId, refs.length > 0 ? refs : ['']],
      )
    })
  }

  return saved
}

export async function crawlDetails({ pool, config, limit = 10, full = false, matchIds = [], log = console.log }) {
  const feeds = full ? Object.keys(MATCH_FEEDS) : ['injury']
  const runId = await startRun(pool, { source: 'sporttery.match_detail', meta: { limit, full, feeds, matchIds } })
  const summary = { matches: 0, requests: 0, results: 0, injuries: 0, failed: 0 }

  try {
    // 指定了 --match 就只抓这几场（补数据/排查用），否则按开赛时间取最近的一批
    const { rows: matches } =
      matchIds.length > 0
        ? await pool.query(
            `select sporttery_match_id, home_name, away_name, kickoff_at
             from match where sporttery_match_id = any($1::bigint[])
             order by kickoff_at`,
            [matchIds],
          )
        : await pool.query(
            `select sporttery_match_id, home_name, away_name, kickoff_at
             from match
             where kickoff_at between now() - interval '14 days' and now() + interval '3 days'
             order by abs(extract(epoch from (kickoff_at - now())))
             limit $1`,
            [limit],
          )

    if (matches.length === 0) {
      await finishRun(pool, runId, { status: 'skipped' })
      return summary
    }

    for (const match of matches) {
      summary.matches += 1

      for (const feed of feeds) {
        try {
          const value = await fetchMatchFeed(config, {
            sportteryMatchId: match.sporttery_match_id,
            feed,
          })
          await storeFeed(pool, match.sporttery_match_id, feed, value)
          summary.requests += 1

          if (feed === 'result') {
            summary.results += await applyResults(pool, parseResultEntries(value))
          }

          if (feed === 'injury') {
            const teams = ['home', 'away']
              .map((side) => value?.[side])
              .filter((block) => block && typeof block === 'object')
              .map((block) => ({
                teamSportteryId: Number(block.sportteryTeamId),
              }))

            summary.injuries += await applyInjuries(
              pool,
              { teams, entries: parseInjuryEntries(value) },
              log,
            )
          }
        } catch (error) {
          summary.failed += 1
          log(
            `  ! ${match.home_name} vs ${match.away_name} 的 ${MATCH_FEEDS[feed].label} 抓取失败：` +
              (error instanceof Error ? error.message : String(error)),
          )
        }

        await sleep(config.delayMs)
      }
    }

    await finishRun(pool, runId, {
      status: 'ok',
      itemCount: summary.matches,
      changedCount: summary.results + summary.injuries,
    })

    return summary
  } catch (error) {
    await finishRun(pool, runId, { status: 'failed', error: error.message })
    throw error
  }
}
