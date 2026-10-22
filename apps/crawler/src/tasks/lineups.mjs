import { readFile } from 'node:fs/promises'

import { withTransaction } from '../db.mjs'

/**
 * 阵容入库（来源无关）。
 *
 * - 浏览器抓取、手工 JSON 都走这里，保证写入行为一致；
 * - 球员按 (球队, 姓名) 复用，避免同名重复建号；
 * - 阵容整份替换：来源每次给的都是完整名单。
 */

const UPSERT_LINEUP = `
  insert into match_lineup (match_id, team_id, formation, coach, confirmed, source, captured_at)
  values ($1, $2, $3, $4, $5, $6, now())
  on conflict (match_id, team_id) do update set
    formation   = excluded.formation,
    coach       = excluded.coach,
    confirmed   = excluded.confirmed,
    source      = excluded.source,
    captured_at = now()
`

const INSERT_LINEUP_PLAYER = `
  insert into match_lineup_player (match_id, team_id, player_id, is_starter, position, shirt_no)
  values ($1, $2, $3, $4, $5, $6)
  on conflict (match_id, team_id, player_id) do update set
    is_starter = excluded.is_starter,
    position   = excluded.position,
    shirt_no   = excluded.shirt_no
`

async function resolvePlayer(client, teamId, entry) {
  const name = String(entry?.name ?? '').trim()
  if (!name) {
    return null
  }

  const existing = await client.query('select id from player where team_id = $1 and name = $2 limit 1', [
    teamId,
    name,
  ])
  if (existing.rows.length > 0) {
    return existing.rows[0].id
  }

  const inserted = await client.query(
    `insert into player (team_id, name, position, shirt_no, updated_at)
     values ($1, $2, $3, $4, now())
     returning id`,
    [teamId, name, entry.position ?? null, Number.isFinite(Number(entry.no)) ? Number(entry.no) : null],
  )
  return inserted.rows[0].id
}

async function importSide(client, { matchId, teamId, side, source }) {
  const players = Array.isArray(side?.players) ? side.players : []
  if (players.length === 0) {
    return 0
  }

  await client.query(UPSERT_LINEUP, [
    matchId,
    teamId,
    side.formation ?? null,
    side.coach ?? null,
    side.confirmed === true,
    source,
  ])

  await client.query('delete from match_lineup_player where match_id = $1 and team_id = $2', [
    matchId,
    teamId,
  ])

  let saved = 0
  for (const entry of players) {
    const playerId = await resolvePlayer(client, teamId, entry)
    if (!playerId) {
      continue
    }
    await client.query(INSERT_LINEUP_PLAYER, [
      matchId,
      teamId,
      playerId,
      entry.starter !== false,
      entry.position ?? null,
      Number.isFinite(Number(entry.no)) ? Number(entry.no) : null,
    ])
    saved += 1
  }

  return saved
}

/**
 * 写入一场比赛的阵容。
 *
 * @param {object} input
 * @param {import('pg').Pool} input.pool
 * @param {number} input.sportteryMatchId
 * @param {{formation?:string,coach?:string,confirmed?:boolean,players:Array}} input.home
 * @param {{formation?:string,coach?:string,confirmed?:boolean,players:Array}} input.away
 * @param {string} input.source
 * @param {boolean} [input.dryRun] 事务内写入后回滚
 */
export async function writeLineup({ pool, sportteryMatchId, home, away, source = 'manual', dryRun = false }) {
  let summary = null

  const run = withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      'select id, home_team_id, away_team_id from match where sporttery_match_id = $1',
      [sportteryMatchId],
    )
    if (rows.length === 0) {
      throw new Error(`库里没有这场比赛: ${sportteryMatchId}`)
    }

    const match = rows[0]
    const homeCount = await importSide(client, {
      matchId: match.id,
      teamId: match.home_team_id,
      side: home,
      source,
    })
    const awayCount = await importSide(client, {
      matchId: match.id,
      teamId: match.away_team_id,
      side: away,
      source,
    })

    summary = { sportteryMatchId, home: homeCount, away: awayCount }
    if (dryRun) {
      throw new Error('__rollback__')
    }
  })

  try {
    await run
  } catch (error) {
    if (!(dryRun && error.message === '__rollback__')) {
      throw error
    }
  }

  return summary
}

/**
 * 从 JSON 文件批量导入。
 *
 * 文件格式见 apps/crawler/README.md。
 */
export async function importLineups({ pool, file, dryRun = false, log = console.log }) {
  // Windows 下用记事本/Set-Content 存的文件常带 BOM，先剥掉再解析
  const text = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '')
  const raw = JSON.parse(text)
  const source = String(raw.source ?? 'manual').slice(0, 32)
  const matches = Array.isArray(raw.matches) ? raw.matches : []

  if (matches.length === 0) {
    throw new Error('文件里没有 matches 数组')
  }

  let matchesDone = 0
  let playersDone = 0
  const skipped = []

  for (const entry of matches) {
    const sportteryMatchId = Number(entry?.sportteryMatchId)
    if (!Number.isInteger(sportteryMatchId) || sportteryMatchId <= 0) {
      skipped.push(`非法 matchId: ${entry?.sportteryMatchId}`)
      continue
    }

    try {
      const summary = await writeLineup({
        pool,
        sportteryMatchId,
        home: entry.home,
        away: entry.away,
        source,
        dryRun,
      })
      if (summary) {
        matchesDone += 1
        playersDone += summary.home + summary.away
      }
    } catch (error) {
      skipped.push(`${sportteryMatchId}: ${error.message}`)
    }
  }

  for (const item of skipped) {
    log(`  ! ${item}`)
  }

  return { source, matches: matchesDone, players: playersDone, skipped: skipped.length, dryRun }
}
