import { query } from '../db.mjs'

/**
 * 一次把串关里所有比赛的数据取齐：3 条 SQL，避免 N 场 × 3 次往返。
 */

const MATCH_SQL = `
  select sporttery_match_id, match_num_str, league_name, home_name, away_name, kickoff_at
  from match
  where sporttery_match_id = any($1::bigint[])
`

const ODDS_SQL = `
  select m.sporttery_match_id, s.odds
  from match m
  join lateral (
    select odds from match_odds_snapshot s
    where s.match_id = m.id
    order by s.captured_at desc
    limit 1
  ) s on true
  where m.sporttery_match_id = any($1::bigint[])
`

const INJURY_SQL = `
  select sporttery_match_id, payload
  from match_feed
  where feed = 'injury' and sporttery_match_id = any($1::bigint[])
`

export async function loadParlayContext(config, matchIds) {
  const ids = matchIds.map((id) => String(id))
  const [matchResult, oddsResult, injuryResult] = await Promise.all([
    query(config, MATCH_SQL, [ids]),
    query(config, ODDS_SQL, [ids]),
    query(config, INJURY_SQL, [ids]),
  ])

  const oddsBySportteryId = new Map(
    oddsResult.rows.map((row) => [String(row.sporttery_match_id), row.odds]),
  )
  const injuryBySportteryId = new Map(
    injuryResult.rows.map((row) => [String(row.sporttery_match_id), row.payload]),
  )

  const context = new Map()
  for (const row of matchResult.rows) {
    const key = String(row.sporttery_match_id)
    context.set(key, {
      match: row,
      odds: oddsBySportteryId.get(key) ?? null,
      injury: injuryBySportteryId.get(key) ?? null,
    })
  }
  return context
}

export function formatKickoff(iso) {
  if (!iso) {
    return ''
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`
}
