import { finishRun, startRun, withTransaction } from '../db.mjs'
import { normalizeMatch } from '../normalize.mjs'
import { fetchMatches } from '../sporttery.mjs'

/**
 * 在售赛程 + 赔率。
 *
 * 一轮一个事务：比赛/球队/联赛 upsert，赔率按 hash 去重插快照，
 * 最后把本轮没再出现的在售比赛标成 closed（不删除，历史赔率还要用）。
 */

const UPSERT_LEAGUE = `
  insert into league (name) values ($1)
  on conflict (name) do update set name = excluded.name
  returning id
`

const UPSERT_TEAM = `
  insert into team (sporttery_id, name_abbr, updated_at)
  values ($1, $2, now())
  on conflict (sporttery_id) do update set
    name_abbr = excluded.name_abbr,
    updated_at = now()
  returning id
`

const UPSERT_MATCH = `
  insert into match
    (sporttery_match_id, business_date, match_num_str, kickoff_at, league_id, league_name,
     home_team_id, away_team_id, home_name, away_name, status, sell_status,
     last_seen_at, raw, updated_at)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'scheduled',
          case when $4 <= now() then 'closed' else 'on_sale' end, now(), $11, now())
  on conflict (sporttery_match_id) do update set
    business_date = excluded.business_date,
    match_num_str = excluded.match_num_str,
    kickoff_at    = excluded.kickoff_at,
    league_id     = excluded.league_id,
    league_name   = excluded.league_name,
    home_team_id  = excluded.home_team_id,
    away_team_id  = excluded.away_team_id,
    home_name     = excluded.home_name,
    away_name     = excluded.away_name,
    -- 体彩列表在结算前仍会返回已开赛的比赛，不能让它把本地停售状态改回在售
    sell_status   = case when excluded.kickoff_at <= now() then 'closed' else 'on_sale' end,
    last_seen_at  = now(),
    raw           = excluded.raw,
    updated_at    = now()
  returning id
`

const INSERT_ODDS = `
  insert into match_odds_snapshot (match_id, odds, content_hash)
  values ($1, $2, $3)
  on conflict (match_id, content_hash) do nothing
`

const CLOSE_STALE = `
  update match
  set sell_status = 'closed', updated_at = now()
  where sell_status = 'on_sale' and last_seen_at < $1
`

export async function crawlMatches({ pool, config, log = console.log }) {
  const runId = await startRun(pool, { source: 'sporttery.matches' })
  const summary = { matches: 0, changed: 0, skipped: 0, closed: 0 }

  try {
    const groups = await fetchMatches(config)

    // 用数据库时钟做基准，避免本机时钟漂移误伤
    const { rows: clock } = await pool.query('select now() as now')
    const runStartedAt = clock[0].now

    await withTransaction(pool, async (client) => {
      const leagueIds = new Map()
      const teamIds = new Map()

      for (const group of groups) {
        const businessDate = group?.businessDate
        for (const item of group?.subMatchList ?? []) {
          let row
          try {
            row = normalizeMatch(item, businessDate)
          } catch (error) {
            summary.skipped += 1
            log(`  ! 跳过异常赛事 ${item?.matchId}: ${error.message}`)
            continue
          }

          if (!row.sportteryMatchId || !row.homeTeamId || !row.awayTeamId) {
            summary.skipped += 1
            log(`  ! 跳过缺少 ID 的赛事 ${item?.matchNumStr ?? '?'}`)
            continue
          }

          if (!leagueIds.has(row.leagueName)) {
            const { rows } = await client.query(UPSERT_LEAGUE, [row.leagueName])
            leagueIds.set(row.leagueName, rows[0].id)
          }

          const teamKeys = [
            [row.homeTeamId, row.homeName],
            [row.awayTeamId, row.awayName],
          ]
          for (const [sportteryId, name] of teamKeys) {
            if (!teamIds.has(sportteryId)) {
              const { rows } = await client.query(UPSERT_TEAM, [sportteryId, name])
              teamIds.set(sportteryId, rows[0].id)
            }
          }

          const { rows: matchRows } = await client.query(UPSERT_MATCH, [
            row.sportteryMatchId,
            row.businessDate,
            row.matchNumStr,
            row.kickoffAt,
            leagueIds.get(row.leagueName),
            row.leagueName,
            teamIds.get(row.homeTeamId),
            teamIds.get(row.awayTeamId),
            row.homeName,
            row.awayName,
            row.raw,
          ])

          if (Object.keys(row.odds).length > 0) {
            const inserted = await client.query(INSERT_ODDS, [
              matchRows[0].id,
              row.odds,
              row.oddsHash,
            ])
            if (inserted.rowCount > 0) {
              summary.changed += 1
            }
          }

          summary.matches += 1
        }
      }

      const closed = await client.query(CLOSE_STALE, [runStartedAt])
      summary.closed = closed.rowCount ?? 0
    })

    await finishRun(pool, runId, {
      status: 'ok',
      itemCount: summary.matches,
      changedCount: summary.changed,
    })

    return summary
  } catch (error) {
    await finishRun(pool, runId, { status: 'failed', error: error.message })
    throw error
  }
}
