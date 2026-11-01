import { query } from '../db.mjs'
import { createTtlCache } from '../lib.mjs'
import { weekdayLabel } from '../periods.mjs'

/**
 * 赛果开奖读取。
 *
 * 列表按**期（销售日）**分组，而不是按自然日：竞彩按「周X」分期，周六 001–0xx
 * 从周六下午一直排到周日凌晨，按日期切会把同一期拆成两天。
 * 前端「赛果」区块和投注结算共用同一份行结构：结算只需要 id + 各玩法结果。
 */

const cache = createTtlCache({ ttlMs: 30_000, maxEntries: 24 })

/** 期列表默认给最近多少期（够翻两周） */
const PERIOD_PAGE_SIZE = 24

const COLUMNS = `
  r.sporttery_match_id, r.match_num_str, r.match_date, r.league_id, r.league_name,
  r.home_name, r.away_name, r.full_home, r.full_away, r.half_home, r.half_away,
  r.goal_line, r.had_result, r.hhad_result, r.ttg_result, r.crs_result, r.hafu_result,
  r.settled, r.result_status, r.pool_status, r.updated_at,
  m.kickoff_at
`

/**
 * 期（销售日）表达式。
 *
 * 优先用 `match.business_date`（爬虫写入的销售日）；关联不到 match 的老赛果，
 * 用 `match_num_str` 的「周X」前缀把开赛日倒推回那一期：例如「周六021」开赛在周日凌晨，
 * 期就是开赛日之前最近的那个周六。
 */
function periodExpr(r = 'r', m = 'm') {
  return `coalesce(
    ${m}.business_date,
    case
      when ${r}.match_num_str ~ '^周[一二三四五六日]'
        then (${r}.match_date - ((extract(isodow from ${r}.match_date)::int
             - position(substr(${r}.match_num_str, 2, 1) in '一二三四五六日') + 7) % 7))::date
      else ${r}.match_date
    end
  )`
}

const PERIODS_SQL = `
  select to_char(${periodExpr()}, 'YYYY-MM-DD') as period,
         count(*)::int as total,
         count(*) filter (where r.settled)::int as settled
  from match_result r
  left join match m on m.sporttery_match_id = r.sporttery_match_id
  group by 1
  order by 1 desc
  limit $1
`

const PERIOD_ITEMS_SQL = `
  select ${COLUMNS},
         to_char(${periodExpr()}, 'YYYY-MM-DD') as period
  from match_result r
  left join match m on m.sporttery_match_id = r.sporttery_match_id
  where ${periodExpr()} = $1::date
  order by r.match_num_str asc nulls last, r.sporttery_match_id asc
  limit $2
`

/** 没指定期时取最近一期：一次查询内定位期，不先跑一遍列表。 */
const LATEST_ITEMS_SQL = `
  select ${COLUMNS},
         to_char(${periodExpr()}, 'YYYY-MM-DD') as period
  from match_result r
  left join match m on m.sporttery_match_id = r.sporttery_match_id
  where ${periodExpr()} = (
    select max(${periodExpr('r2', 'm2')})
    from match_result r2
    left join match m2 on m2.sporttery_match_id = r2.sporttery_match_id
  )
  order by r.match_num_str asc nulls last, r.sporttery_match_id asc
  limit $1
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
    /** 期（销售日），形如 2026-10-31；跨零点场次归前一天 */
    period: row.period ?? '',
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

function toPeriodSummary(row) {
  const period = String(row.period ?? '')
  return {
    period,
    label: weekdayLabel(period),
    count: Number(row.total) || 0,
    settled: Number(row.settled) || 0,
  }
}

function latestStamp(rows) {
  return rows.reduce((latest, row) => {
    const stamp = row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
    return !latest || (stamp && stamp > latest) ? stamp : latest
  }, null)
}

/**
 * 列表：按期取，最多 500 条。
 *
 * @param {object} options
 * @param {string} [options.period]  期（销售日）'YYYY-MM-DD'；不传 = 最近一期
 * @param {number} [options.limit]
 */
export async function listResults(config, { period = '', limit = 200 } = {}) {
  const key = `${period || 'latest'}|${limit}`
  const cached = cache.get(key)
  if (cached) {
    return { ...cached, cache: 'hit' }
  }

  // 期列表和当期明细互不依赖，并发跑；跨境库一次往返 2–4s，串行会白白多等一趟
  const [{ rows: periodRows }, { rows: itemRows }] = await Promise.all([
    query(config, PERIODS_SQL, [PERIOD_PAGE_SIZE]),
    period
      ? query(config, PERIOD_ITEMS_SQL, [period, limit])
      : query(config, LATEST_ITEMS_SQL, [limit]),
  ])

  const items = itemRows.map(toResultShape)
  const periods = periodRows.map(toPeriodSummary)
  const selected = period || items[0]?.period || periods[0]?.period || ''

  const result = {
    period: selected,
    label: weekdayLabel(selected),
    count: items.length,
    settled: items.filter((item) => item.settled).length,
    updatedAt: latestStamp(itemRows),
    periods,
    items,
  }
  cache.set(key, result)
  return { ...result, cache: 'miss' }
}

/** 结算用：按 sporttery_match_id 批量取赛果（不含赔率，给只关心奖金的统计用）。 */
export async function getResultsByIds(config, ids) {
  const unique = Array.from(new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))))
  if (unique.length === 0) {
    return new Map()
  }

  const { rows } = await query(config, BY_IDS_SQL, [unique])
  return new Map(rows.map((row) => [Number(row.sporttery_match_id), toResultShape(row)]))
}

/**
 * 结算上下文：一次查询同时取「赛果 + 开奖赔率」。
 *
 * 开奖赔率（停售前最后一份官方赔率）优先 `match_result.closing_odds`（赛果入库时整包固化，
 * 不受 120 天快照裁剪影响）；还没固化的场次回退到该场最新一份 `match_odds_snapshot`。
 *
 * 两个 Map 分开返回：投注可能落在「有比赛没赛果」（待开奖）或「有赛果没比赛行」
 * （历史回灌）的场次上，不能假设任何一边一定存在。
 *
 * 合并成一条 SQL 是因为库在跨境链路上，一次往返 2–4s；结算要用两次数据，
 * 分成两条查询等于白白多花一趟。
 */
const SETTLEMENT_SQL = `
  select ids.id as match_id,
         ${COLUMNS},
         coalesce(r.closing_odds, s.odds) as closing_odds,
         coalesce(r.closing_odds_captured_at, s.captured_at) as closing_odds_captured_at
  from unnest($1::bigint[]) as ids(id)
  left join match_result r on r.sporttery_match_id = ids.id
  left join match m on m.sporttery_match_id = ids.id
  left join lateral (
    select s.odds, s.captured_at
    from match_odds_snapshot s
    where s.match_id = m.id
    order by s.captured_at desc
    limit 1
  ) s on true
`

export async function getSettlementContextByIds(config, ids) {
  const unique = Array.from(new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))))
  const results = new Map()
  const closing = new Map()
  if (unique.length === 0) {
    return { results, closing }
  }

  const { rows } = await query(config, SETTLEMENT_SQL, [unique])
  for (const row of rows) {
    const id = Number(row.match_id)
    if (row.sporttery_match_id !== null && row.sporttery_match_id !== undefined) {
      results.set(id, toResultShape(row))
    }
    if (row.closing_odds) {
      closing.set(id, {
        odds: row.closing_odds,
        capturedAt: row.closing_odds_captured_at instanceof Date
          ? row.closing_odds_captured_at.toISOString()
          : (row.closing_odds_captured_at ?? null),
      })
    }
  }

  return { results, closing }
}

/**
 * 总进球赔率分布样本。
 *
 * 优先读 `match_result.ttg_odds`（赛果入库时固化的收盘赔率，不受 120 天快照裁剪影响）；
 * 迁移前/爬虫还没固化的行退回当前保留期内的最后一份 `match_odds_snapshot`。
 * 这里特意按 `sporttery_match_id` 关联 match，而不是 `match_result.match_id`：
 * 历史赛果可能没回填内部 id，但两边的体彩 id 是一致的。
 */
const TTG_SAMPLE_SQL = `
  select
    r.sporttery_match_id,
    to_char(r.match_date, 'YYYY-MM-DD') as match_date,
    r.league_name, r.home_name, r.away_name,
    r.full_home, r.full_away, r.ttg_result,
    coalesce(r.ttg_odds, fallback.ttg_odds) as ttg_odds,
    coalesce(r.ttg_odds_captured_at, fallback.captured_at) as odds_captured_at
  from match_result r
  left join match m on m.sporttery_match_id = r.sporttery_match_id
  left join lateral (
    select s.odds->'ttg' as ttg_odds, s.captured_at
    from match_odds_snapshot s
    where s.match_id = m.id
      and r.ttg_odds is null
    order by s.captured_at desc
    limit 1
  ) fallback on true
  where r.ttg_result is not null
    and coalesce(r.ttg_odds, fallback.ttg_odds) is not null
  order by r.match_date desc, r.sporttery_match_id desc
`

const TTG_COVERAGE_SQL = `
  select
    count(*)::int as total,
    max(updated_at) as updated_at
  from match_result
  where ttg_result is not null
`

function toTtgSample(row) {
  return {
    matchId: Number(row.sporttery_match_id),
    matchDate: row.match_date ?? '',
    leagueName: row.league_name ?? '',
    homeName: row.home_name ?? '',
    awayName: row.away_name ?? '',
    homeScore: row.full_home === null || row.full_home === undefined ? null : Number(row.full_home),
    awayScore: row.full_away === null || row.full_away === undefined ? null : Number(row.full_away),
    ttg: row.ttg_result === null || row.ttg_result === undefined ? null : Number(row.ttg_result),
    ttgOdds: row.ttg_odds,
    oddsCapturedAt: row.odds_captured_at instanceof Date
      ? row.odds_captured_at.toISOString()
      : (row.odds_captured_at ?? null),
  }
}

export async function listTtgOddsSamples(config) {
  const { rows } = await query(config, TTG_SAMPLE_SQL)
  return rows.map(toTtgSample)
}

export async function getTtgResultCoverage(config) {
  const { rows } = await query(config, TTG_COVERAGE_SQL)
  const row = rows[0] ?? {}
  return {
    total: Number(row.total) || 0,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : (row.updated_at ?? null),
  }
}
