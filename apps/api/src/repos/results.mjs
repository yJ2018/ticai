import { query } from '../db.mjs'
import { createTtlCache } from '../lib.mjs'

/**
 * 赛果开奖读取。
 *
 * 列表按比赛日倒序，前端「赛果」区块和投注结算共用同一份行结构：
 * 结算只需要 id + 各玩法结果，多取几列也不贵（一天几十场）。
 */

const cache = createTtlCache({ ttlMs: 30_000, maxEntries: 24 })

const COLUMNS = `
  r.sporttery_match_id, r.match_num_str, r.match_date, r.league_id, r.league_name,
  r.home_name, r.away_name, r.full_home, r.full_away, r.half_home, r.half_away,
  r.goal_line, r.had_result, r.hhad_result, r.ttg_result, r.crs_result, r.hafu_result,
  r.settled, r.result_status, r.pool_status, r.updated_at,
  m.kickoff_at
`

/**
 * 上游的 matchDate 是「销售日」，凌晨/次日场次会挂在前一天。
 * 展示与按天筛选都用真实开赛时间（关联到 match 后取 kickoff_at），
 * 关联不上的老比赛退回销售日。
 */
const MATCH_DAY = `coalesce(m.kickoff_at at time zone 'Asia/Shanghai', r.match_date::timestamp)`

const LIST_SQL = `
  select ${COLUMNS}
  from match_result r
  left join match m on m.sporttery_match_id = r.sporttery_match_id
  where ${MATCH_DAY}::date between $1::date and $2::date
  order by ${MATCH_DAY} asc, r.match_num_str asc
  limit $3
`

const BY_IDS_SQL = `
  select ${COLUMNS}
  from match_result r
  left join match m on m.sporttery_match_id = r.sporttery_match_id
  where r.sporttery_match_id = any($1::bigint[])
`

export function toResultShape(row) {
  return {
    matchId: Number(row.sporttery_match_id),
    matchNo: row.match_num_str ?? '',
    matchDate: row.match_date instanceof Date
      ? row.match_date.toISOString().slice(0, 10)
      : String(row.match_date ?? '').slice(0, 10),
    leagueId: row.league_id === null || row.league_id === undefined ? null : Number(row.league_id),
    leagueName: row.league_name ?? '',
    homeName: row.home_name ?? '',
    awayName: row.away_name ?? '',
    homeScore: row.full_home === null || row.full_home === undefined ? null : Number(row.full_home),
    awayScore: row.full_away === null || row.full_away === undefined ? null : Number(row.full_away),
    homeHalfScore: row.half_home === null || row.half_home === undefined ? null : Number(row.half_home),
    awayHalfScore: row.half_away === null || row.half_away === undefined ? null : Number(row.half_away),
    goalLine: row.goal_line === null || row.goal_line === undefined ? null : Number(row.goal_line),
    had: row.had_result ?? null,
    hhad: row.hhad_result ?? null,
    ttg: row.ttg_result === null || row.ttg_result === undefined ? null : Number(row.ttg_result),
    crs: row.crs_result ?? null,
    hafu: row.hafu_result ?? null,
    settled: Boolean(row.settled),
    status: row.result_status ?? '',
    poolStatus: row.pool_status ?? '',
    kickoffAt: row.kickoff_at instanceof Date ? row.kickoff_at.toISOString() : (row.kickoff_at ?? null),
  }
}

/** 列表：按比赛日区间，最多 500 条。 */
export async function listResults(config, { from, to, limit = 200 }) {
  const key = `${from}|${to}|${limit}`
  const cached = cache.get(key)
  if (cached) {
    return { ...cached, cache: 'hit' }
  }

  const { rows } = await query(config, LIST_SQL, [from, to, limit])
  const items = rows.map(toResultShape)
  const updatedAt = rows.reduce((latest, row) => {
    const stamp = row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
    return !latest || (stamp && stamp > latest) ? stamp : latest
  }, null)

  const result = { items, from, to, updatedAt }
  cache.set(key, result)
  return { ...result, cache: 'miss' }
}

/** 结算用：按 sporttery_match_id 批量取赛果。 */
export async function getResultsByIds(config, ids) {
  const unique = Array.from(new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))))
  if (unique.length === 0) {
    return new Map()
  }

  const { rows } = await query(config, BY_IDS_SQL, [unique])
  return new Map(rows.map((row) => [Number(row.sporttery_match_id), toResultShape(row)]))
}
