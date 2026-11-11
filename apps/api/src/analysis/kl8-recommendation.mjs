import {
  POOL_WINDOWS,
  allocateZones,
  computeNumberIndicators,
  formatBigSmall,
  formatOddEven,
  formatZones,
  pad2,
  pickZonePool,
  rankPoolNumbers,
  summarizeTargets,
  zoneIndexOf,
} from './pool-utils.mjs'

/**
 * 快乐8 号码推演（Python 版在 apps/analysis/app/analysis/kl8.py）。
 *
 * 玩法结构：1–80 每期开 20 个号；常用「选十」玩法是从 80 个号里选 10 个。
 * 分析口径：
 *   1. 80 个号码统计近 10 / 30 / 100 期频次与当前遗漏；
 *   2. 按 1–20 / 21–40 / 41–60 / 61–80 四区各取 5 个，组成 20 码参考池；
 *   3. 按近 30 期四区均值把 10 个名额分配给四区，再从各区池内按评分取号，
 *      组成「选十」10 码主推；
 *   4. 输出号码池、主推、冷热 / 遗漏排行与可解释理由。
 *
 * 只取最近 300 期：快乐8 每日开奖，300 期约 10 个月。
 */

const KL8_WINDOW = 300
const DRAW_COUNT = 20
const NUMBER_MIN = 1
const NUMBER_MAX = 80
const PRIMARY_COUNT = 10
const ZONE_LIMITS = [20, 40, 60, 80]
const POOL_PER_ZONE = 5
const BIG_MIN = 41
const MIN_SAMPLE = 30

export function analyzeKl8Recommendation(entries) {
  const draws = entries
    .slice(0, KL8_WINDOW)
    .map(toDraw)
    .filter((draw) => draw !== null)

  if (draws.length < MIN_SAMPLE) {
    return null
  }

  const windows = {
    short: Math.min(POOL_WINDOWS.short, draws.length),
    recent: Math.min(POOL_WINDOWS.recent, draws.length),
    long: Math.min(POOL_WINDOWS.long, draws.length),
  }
  const series = draws.map((draw) => draw.numbers)
  const ranking = rankPoolNumbers(series, {
    min: NUMBER_MIN,
    max: NUMBER_MAX,
    pickPerDraw: DRAW_COUNT,
    windows,
  })

  const pool = pickZonePool(ranking, {
    zoneLimits: ZONE_LIMITS,
    perZone: POOL_PER_ZONE,
  })
  const targets = summarizeTargets(series, {
    window: windows.recent,
    pickCount: DRAW_COUNT,
    bigMin: BIG_MIN,
    zoneLimits: ZONE_LIMITS,
  })

  const allocation = allocateZones(targets.averageZones, PRIMARY_COUNT)
  const primary = pickPrimaryNumbers(ranking, pool, allocation)
  if (primary.length < PRIMARY_COUNT) {
    return null
  }

  const poolMetrics = computeNumberIndicators(pool, {
    bigMin: BIG_MIN,
    zoneLimits: ZONE_LIMITS,
  })
  const metrics = computeNumberIndicators(primary, {
    bigMin: BIG_MIN,
    zoneLimits: ZONE_LIMITS,
  })

  const hot = [...ranking]
    .sort(
      (left, right) =>
        right.recentCount - left.recentCount ||
        right.shortCount - left.shortCount ||
        left.number - right.number,
    )
    .slice(0, 10)
  const cold = [...ranking]
    .sort(
      (left, right) =>
        left.recentCount - right.recentCount ||
        right.missSpan - left.missSpan ||
        left.score - right.score ||
        left.number - right.number,
    )
    .slice(0, 10)
  const overdue = [...ranking]
    .sort((left, right) => right.missSpan - left.missSpan || left.number - right.number)
    .slice(0, 10)

  return {
    windows,
    sampleSize: draws.length,
    picks: {
      primary,
      pool,
    },
    allocation,
    ranking,
    hot,
    cold,
    overdue,
    targets,
    metrics,
    poolMetrics,
    reasons: buildReasons({
      windows,
      hot,
      overdue,
      primary,
      pool,
      metrics,
      targets,
      allocation,
    }),
  }
}

function toDraw(entry) {
  const numbers = entry?.numbers
  if (!Array.isArray(numbers) || numbers.length < DRAW_COUNT) {
    return null
  }

  const parsed = numbers.slice(0, DRAW_COUNT).map(Number)
  if (
    parsed.some(
      (value) => !Number.isInteger(value) || value < NUMBER_MIN || value > NUMBER_MAX,
    )
  ) {
    return null
  }
  if (new Set(parsed).size !== DRAW_COUNT) {
    return null
  }

  return { numbers: parsed.sort((left, right) => left - right) }
}

/**
 * 每个区按分配名额从 20 码池里取评分最高的号码；池内不足时从全量排行补齐。
 */
function pickPrimaryNumbers(ranking, pool, allocation) {
  const poolSet = new Set(pool)
  const byZone = Array.from({ length: ZONE_LIMITS.length }, () => [])
  for (const stat of ranking) {
    if (poolSet.has(stat.number)) {
      byZone[zoneIndexOf(stat.number, ZONE_LIMITS)].push(stat)
    }
  }

  const picked = []
  for (let zone = 0; zone < ZONE_LIMITS.length; zone += 1) {
    const take = Math.min(allocation[zone] ?? 0, byZone[zone].length)
    for (let index = 0; index < take; index += 1) {
      picked.push(byZone[zone][index].number)
    }
  }

  if (picked.length < PRIMARY_COUNT) {
    const pickedSet = new Set(picked)
    for (const stat of ranking) {
      if (picked.length >= PRIMARY_COUNT) {
        break
      }
      if (!pickedSet.has(stat.number)) {
        picked.push(stat.number)
        pickedSet.add(stat.number)
      }
    }
  }

  return picked.slice(0, PRIMARY_COUNT).sort((left, right) => left - right)
}

function buildReasons({ windows, hot, overdue, primary, pool, metrics, targets, allocation }) {
  const expectedRecent = (windows.recent * DRAW_COUNT) / (NUMBER_MAX - NUMBER_MIN + 1)
  const hotText = hot
    .slice(0, 3)
    .map(
      (stat) =>
        `${pad2(stat.number)}（${stat.recentCount} 次）`,
    )
    .join('、')
  const overdueText = overdue
    .slice(0, 3)
    .map((stat) => `${pad2(stat.number)}（遗漏 ${stat.missSpan} 期）`)
    .join('、')
  const hotExpectedText = `近 ${windows.recent} 期每号平均出现 ${expectedRecent.toFixed(1)} 次`

  return [
    `近 ${windows.recent} 期热号：${hotText}；${hotExpectedText}。`,
    `当前遗漏最久：${overdueText}；冷号回补与热号延续各留了位置。`,
    `选十主推 ${primary.map((number) => pad2(number)).join(' ')}，和值 ${metrics.sum}、跨度 ${metrics.span}，奇偶 ${formatOddEven(metrics)}、大小 ${formatBigSmall(metrics)}、四区 ${formatZones(metrics)}、连号 ${metrics.consecutive} 组；近 ${windows.recent} 期均值 ${targets.averageSum.toFixed(1)} / ${targets.averageSpan.toFixed(1)}。`,
    `20 码参考池按四区各取 5 码；选十主推按近 ${windows.recent} 期四区均值分配为 ${allocation.join(':')}，从池内按评分取号。`,
    `选十玩法理论命中期望 2.5 个（10 × 20 / 80），命中分布只作娱乐参考。`,
  ]
}
