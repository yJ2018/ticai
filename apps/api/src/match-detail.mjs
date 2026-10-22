/**
 * 纯函数：match + match_feed → 对战详情响应。
 *
 * 设计原则（对应用户要求「没有的信息就空着」）：
 * - 缺失的订阅源返回 null，不抛错、不省略键；
 * - 空分组原样保留（例如 shooter.home.playerList = []）；
 * - 额外产出 `missing` 数组，前端可以直接据此显示「暂无数据」占位。
 */

export const MATCH_FEED_KEYS = [
  'history',
  'injury',
  'result',
  'future',
  'feature',
  'tables',
  'shooter',
]

const SIDE_LIST_PATHS = [
  ['injury', 'injuriesAndSuspensionsList'],
  ['result', 'matchList'],
  ['future', 'matchList'],
  ['shooter', 'playerList'],
]

function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isEmptyFeed(payload) {
  return !payload || typeof payload !== 'object' || Object.keys(payload).length === 0
}

export function buildMatchDetail({ match, feeds = [] }) {
  const byFeed = new Map(feeds.map((row) => [row.feed, row]))
  const payloads = {}
  const fetchedAt = {}
  const missing = []

  for (const key of MATCH_FEED_KEYS) {
    const row = byFeed.get(key)
    if (!row || isEmptyFeed(row.payload)) {
      payloads[key] = row?.payload ?? null
      missing.push(key)
    } else {
      payloads[key] = row.payload
    }
    fetchedAt[key] = row?.fetched_at ? new Date(row.fetched_at).toISOString() : null
  }

  // 单个分组为空也算缺失：射手榜主队 0 人、伤停某队 0 人都是正常情况
  for (const [feed, listKey] of SIDE_LIST_PATHS) {
    const payload = payloads[feed]
    if (!payload || typeof payload !== 'object') {
      continue
    }
    for (const side of ['home', 'away']) {
      const list = payload?.[side]?.[listKey]
      if (Array.isArray(list) && list.length === 0) {
        missing.push(`${feed}.${side}`)
      }
    }
  }

  return {
    matchId: toNumber(match.sporttery_match_id),
    league: match.league_name ?? null,
    kickoffAt: match.kickoff_at ? new Date(match.kickoff_at).toISOString() : null,
    status: match.status ?? null,
    sellStatus: match.sell_status ?? null,
    home: {
      name: match.home_name ?? null,
      score: toNumber(match.home_score),
      halfScore: toNumber(match.home_half_score),
    },
    away: {
      name: match.away_name ?? null,
      score: toNumber(match.away_score),
      halfScore: toNumber(match.away_half_score),
    },
    // h/d/a × h/d/a，没比分时为 null
    htft: match.htft ?? null,
    resultSource: match.result_source ?? null,
    feeds: payloads,
    fetchedAt,
    missing,
  }
}
