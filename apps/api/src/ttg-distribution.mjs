/**
 * 总进球赔率分布：纯函数，不碰数据库。
 *
 * 输入是「已开奖 + 赛前有总进球赔率」的比赛行；对每场把 8 个选项按赔率升序排，
 * 取出最低 / 倒数第二低 / 第三低，以及最终中奖选项的赔率，再跨场聚合成分布。
 *
 * 口径说明：
 *   - 中奖赔率 = 实际总进球对应选项的赔率（7 表示 7+）；
 *   - 排名按赔率严格更低的数量 + 1 计算，赔率相同并列（例如两个选项同为最低，
 *     押中其中任意一个都记「最低」）；
 *   - 8 个选项缺一个或赔率非法（<= 1）的场次整场跳过，避免半套赔率污染分布。
 */

export const TTG_RANK_LABELS = [
  '最低',
  '第二低',
  '第三低',
  '第四低',
  '第五低',
  '第六低',
  '第七低',
  '最高',
]

export const TTG_SERIES = [
  { key: 'lowest', label: '最低赔率' },
  { key: 'second', label: '倒数第二低' },
  { key: 'third', label: '第三低' },
  { key: 'winning', label: '中奖赔率' },
]

/**
 * 分布区间：当前数据集中在 2.5–6，尾部再放宽到 30+。
 * 区间固定，不随样本变化而跳动，便于不同时间回看同一条曲线。
 */
export const TTG_BIN_EDGES = [1, 2.5, 3, 3.5, 4, 4.5, 5, 6, 8, 10, 15, 20, 30, Infinity]

const SERIES_KEYS = TTG_SERIES.map((item) => item.key)

function round(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return null
  }
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function toFiniteOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseTtgOptions(rawOdds) {
  if (!rawOdds || typeof rawOdds !== 'object' || Array.isArray(rawOdds)) {
    return null
  }

  const options = []
  for (let goals = 0; goals <= 7; goals += 1) {
    const odds = Number(rawOdds[`s${goals}`])
    if (!Number.isFinite(odds) || odds <= 1) {
      return null
    }
    options.push({ goals, odds })
  }

  return options.sort((left, right) => left.odds - right.odds || left.goals - right.goals)
}

function formatEdge(value) {
  return String(value)
}

function binLabel(from, to) {
  if (from === TTG_BIN_EDGES[0]) {
    return `<${formatEdge(to)}`
  }
  if (!Number.isFinite(to)) {
    return `${formatEdge(from)}+`
  }
  return `${formatEdge(from)}–${formatEdge(to)}`
}

function createBins() {
  return TTG_BIN_EDGES.slice(0, -1).map((from, index) => {
    const to = TTG_BIN_EDGES[index + 1]
    return {
      from,
      to: Number.isFinite(to) ? to : null,
      label: binLabel(from, to),
      lowest: 0,
      second: 0,
      third: 0,
      winning: 0,
    }
  })
}

function binIndexFor(value, bins) {
  if (!Number.isFinite(value)) {
    return -1
  }
  if (value < TTG_BIN_EDGES[0]) {
    return 0
  }
  for (let index = 0; index < TTG_BIN_EDGES.length - 1; index += 1) {
    if (value >= TTG_BIN_EDGES[index] && value < TTG_BIN_EDGES[index + 1]) {
      return index
    }
  }
  return bins.length - 1
}

function medianOf(sortedValues) {
  if (sortedValues.length === 0) {
    return null
  }
  const middle = Math.floor(sortedValues.length / 2)
  if (sortedValues.length % 2 === 1) {
    return sortedValues[middle]
  }
  return (sortedValues[middle - 1] + sortedValues[middle]) / 2
}

function describeSeries(key, values) {
  const meta = TTG_SERIES.find((item) => item.key === key)
  if (values.length === 0) {
    return { key, label: meta.label, average: null, median: null, min: null, max: null }
  }

  const sorted = [...values].sort((left, right) => left - right)
  const average = values.reduce((total, value) => total + value, 0) / values.length
  return {
    key,
    label: meta.label,
    average: round(average),
    median: round(medianOf(sorted)),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
  }
}

/**
 * @param {Array<object>} rows 每场一行：matchId / matchDate / ttg / ttgOdds / 比分 / 队名
 * @param {{settledResults?: number, updatedAt?: string|null, recentLimit?: number}} [options]
 */
export function buildTtgOddsDistribution(rows, options = {}) {
  const settledResults = Number.isFinite(Number(options.settledResults))
    ? Math.max(0, Number(options.settledResults))
    : 0
  const recentLimit = Number.isFinite(Number(options.recentLimit))
    ? Math.max(0, Math.floor(Number(options.recentLimit)))
    : 15
  const updatedAt = options.updatedAt ?? null

  const samples = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const ttg = Number(row?.ttg)
    if (!Number.isInteger(ttg) || ttg < 0 || ttg > 7) {
      continue
    }

    const ordered = parseTtgOptions(row?.ttgOdds)
    if (!ordered) {
      continue
    }

    const winner = ordered.find((item) => item.goals === ttg)
    if (!winner) {
      continue
    }

    // 严格更低的数量 + 1：赔率并列时共享排名，但每场只贡献一次
    const rank = ordered.filter((item) => item.odds < winner.odds).length + 1

    samples.push({
      matchId: Number(row.matchId) || 0,
      matchDate: String(row.matchDate ?? ''),
      leagueName: row.leagueName ?? '',
      homeName: row.homeName ?? '',
      awayName: row.awayName ?? '',
      homeScore: toFiniteOrNull(row.homeScore),
      awayScore: toFiniteOrNull(row.awayScore),
      ttg,
      lowest: ordered[0].odds,
      second: ordered[1].odds,
      third: ordered[2].odds,
      winning: winner.odds,
      rank,
      oddsCapturedAt: row.oddsCapturedAt ?? null,
    })
  }

  samples.sort(
    (left, right) =>
      right.matchDate.localeCompare(left.matchDate) || right.matchId - left.matchId,
  )

  const bins = createBins()
  for (const sample of samples) {
    for (const key of SERIES_KEYS) {
      const index = binIndexFor(sample[key], bins)
      if (index >= 0) {
        bins[index][key] += 1
      }
    }
  }

  const series = SERIES_KEYS.map((key) => describeSeries(key, samples.map((sample) => sample[key])))

  const ranks = TTG_RANK_LABELS.map((label, index) => ({
    rank: index + 1,
    label,
    count: 0,
    rate: 0,
  }))
  for (const sample of samples) {
    const entry = ranks[sample.rank - 1]
    if (entry) {
      entry.count += 1
    }
  }
  for (const entry of ranks) {
    entry.rate = samples.length > 0 ? round(entry.count / samples.length, 4) : 0
  }

  const total = samples.length
  const lowestHits = ranks[0]?.count ?? 0
  const top3Hits = ranks.slice(0, 3).reduce((sum, entry) => sum + entry.count, 0)
  const avgLowest = series.find((item) => item.key === 'lowest')?.average
  const avgWinning = series.find((item) => item.key === 'winning')?.average
  const averageRatio =
    total > 0
      ? round(
          samples.reduce((sum, sample) => sum + sample.winning / sample.lowest, 0) / total,
        )
      : null

  const dates = samples.map((sample) => sample.matchDate).filter(Boolean).sort()
  const recent = samples.slice(0, recentLimit).map((sample) => ({
    matchId: sample.matchId,
    matchDate: sample.matchDate,
    leagueName: sample.leagueName,
    homeName: sample.homeName,
    awayName: sample.awayName,
    homeScore: sample.homeScore,
    awayScore: sample.awayScore,
    score:
      sample.homeScore === null || sample.awayScore === null
        ? null
        : `${sample.homeScore}:${sample.awayScore}`,
    ttg: sample.ttg,
    ttgLabel: sample.ttg === 7 ? '7+' : String(sample.ttg),
    lowest: round(sample.lowest),
    second: round(sample.second),
    third: round(sample.third),
    winning: round(sample.winning),
    rank: sample.rank,
    rankLabel: TTG_RANK_LABELS[sample.rank - 1] ?? '',
    oddsCapturedAt: sample.oddsCapturedAt,
  }))

  return {
    sample: {
      matches: total,
      settledResults,
      coverage: settledResults > 0 ? round(total / settledResults, 4) : 0,
      skipped: Math.max(0, (Array.isArray(rows) ? rows.length : 0) - total),
      from: dates[0] ?? null,
      to: dates[dates.length - 1] ?? null,
      updatedAt,
    },
    bins,
    series,
    ranks,
    highlights: {
      lowestHits,
      lowestHitRate: total > 0 ? round(lowestHits / total, 4) : 0,
      top3Hits,
      top3HitRate: total > 0 ? round(top3Hits / total, 4) : 0,
      averageLowest: avgLowest ?? null,
      averageWinning: avgWinning ?? null,
      averageRatio,
    },
    recent,
  }
}
