import {
  POOL_WINDOWS,
  computeNumberIndicators,
  formatBigSmall,
  formatOddEven,
  formatZones,
  pad2,
  pickZonePool,
  rankPoolNumbers,
  summarizeTargets,
} from './pool-utils.mjs'

/**
 * 双色球号码推演（Python 版在 apps/analysis/app/analysis/ssq.py）。
 *
 * 玩法结构：红球 1–33 选 6，蓝球 1–16 选 1。
 * 分析口径与位次型彩种完全不同：
 *   1. 红球 / 蓝球分别统计近 10 / 30 / 100 期频次与当前遗漏；
 *   2. 红球按一区 1–11、二区 12–22、三区 23–33 各取 4 个，组成 12 码池；
 *   3. 从 12 码池枚举 6 码，用近 30 期和值 / 跨度 / 奇偶 / 大小 / 三区均值做软约束，
 *      选出「单注主推」；蓝球取 4 码池，评分第一作主推；
 *   4. 输出号码池、主推单注、备选与可解释理由。
 *
 * 只取最近 300 期：双色球每周 3 期，300 期约 2 年，兼顾近期规律与计算量。
 */

const SSQ_WINDOW = 300
const RED_COUNT = 6
const RED_MIN = 1
const RED_MAX = 33
const BLUE_COUNT = 1
const BLUE_MIN = 1
const BLUE_MAX = 16
const RED_ZONE_LIMITS = [11, 22, 33]
const RED_PER_ZONE = 4
const BLUE_POOL_SIZE = 4
const RED_BIG_MIN = 17
const BLUE_BIG_MIN = 9
const MIN_SAMPLE = 30

export function analyzeSsqRecommendation(entries) {
  const draws = entries
    .slice(0, SSQ_WINDOW)
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
  const redSeries = draws.map((draw) => draw.red)
  const blueSeries = draws.map((draw) => draw.blue)

  const lastRed = redSeries[0]
  const lastRedSet = new Set(lastRed)
  const neighborSet = new Set()
  for (const number of lastRed) {
    if (number - 1 >= RED_MIN) {
      neighborSet.add(number - 1)
    }
    if (number + 1 <= RED_MAX) {
      neighborSet.add(number + 1)
    }
  }

  const redRanking = rankPoolNumbers(redSeries, {
    min: RED_MIN,
    max: RED_MAX,
    pickPerDraw: RED_COUNT,
    windows,
    repeatSet: lastRedSet,
    neighborSet,
  })
  const blueRanking = rankPoolNumbers(blueSeries, {
    min: BLUE_MIN,
    max: BLUE_MAX,
    pickPerDraw: BLUE_COUNT,
    windows,
  })

  const redPool = pickZonePool(redRanking, {
    zoneLimits: RED_ZONE_LIMITS,
    perZone: RED_PER_ZONE,
  })
  const bluePool = blueRanking.slice(0, BLUE_POOL_SIZE).map((stat) => stat.number)
  const bluePoolSorted = [...bluePool].sort((left, right) => left - right)

  const redTargets = summarizeTargets(redSeries, {
    window: windows.recent,
    pickCount: RED_COUNT,
    bigMin: RED_BIG_MIN,
    zoneLimits: RED_ZONE_LIMITS,
  })
  const primaryRed = pickRedCombination(redPool, redRanking, redTargets, lastRedSet)
  if (!primaryRed) {
    return null
  }

  const primaryBlue = blueRanking[0]?.number ?? bluePoolSorted[0]
  const redStatsByNumber = new Map(redRanking.map((stat) => [stat.number, stat]))
  const blueStatsByNumber = new Map(blueRanking.map((stat) => [stat.number, stat]))
  const redPrimarySet = new Set(primaryRed.numbers)

  const redHot = [...redRanking]
    .sort(
      (left, right) =>
        right.recentCount - left.recentCount ||
        right.shortCount - left.shortCount ||
        left.number - right.number,
    )
    .slice(0, 5)
  const redCold = [...redRanking]
    .sort(
      (left, right) =>
        left.recentCount - right.recentCount ||
        right.missSpan - left.missSpan ||
        left.score - right.score ||
        left.number - right.number,
    )
    .slice(0, 5)
  const redOverdue = [...redRanking]
    .sort((left, right) => right.missSpan - left.missSpan || left.number - right.number)
    .slice(0, 5)
  const redAlternates = redRanking
    .filter((stat) => !redPrimarySet.has(stat.number) && redPool.includes(stat.number))
    .slice(0, 6)
    .map((stat) => stat.number)
    .sort((left, right) => left - right)

  const bluePrimarySet = new Set([primaryBlue])
  const blueAlternates = blueRanking
    .filter((stat) => !bluePrimarySet.has(stat.number))
    .slice(0, BLUE_POOL_SIZE - 1)
    .map((stat) => stat.number)
    .sort((left, right) => left - right)
  const blueHot = [...blueRanking]
    .sort(
      (left, right) =>
        right.recentCount - left.recentCount ||
        right.shortCount - left.shortCount ||
        left.number - right.number,
    )
    .slice(0, 4)
  const blueCold = [...blueRanking]
    .sort(
      (left, right) =>
        left.recentCount - right.recentCount ||
        right.missSpan - left.missSpan ||
        left.score - right.score ||
        left.number - right.number,
    )
    .slice(0, 4)
  const blueOverdue = [...blueRanking]
    .sort((left, right) => right.missSpan - left.missSpan || left.number - right.number)
    .slice(0, 4)

  const redMetrics = primaryRed.metrics
  const blueValue = Number(primaryBlue)
  const blueMetrics = {
    odd: blueValue % 2,
    even: blueValue % 2 === 1 ? 0 : 1,
    big: blueValue >= BLUE_BIG_MIN ? 1 : 0,
    small: blueValue >= BLUE_BIG_MIN ? 0 : 1,
  }

  return {
    windows,
    sampleSize: draws.length,
    red: {
      poolSize: redPool.length,
      picks: redPool,
      primary: primaryRed.numbers,
      alternates: redAlternates,
      ranking: redRanking,
      hot: redHot,
      cold: redCold,
      overdue: redOverdue,
      targets: redTargets,
      metrics: redMetrics,
    },
    blue: {
      poolSize: bluePoolSorted.length,
      picks: bluePoolSorted,
      primary: [blueValue],
      alternates: blueAlternates,
      ranking: blueRanking,
      hot: blueHot,
      cold: blueCold,
      overdue: blueOverdue,
      metrics: blueMetrics,
    },
    reasons: buildReasons({
      windows,
      redHot: redHot[0] ?? null,
      redOverdue: redOverdue[0] ?? null,
      blueStats: blueStatsByNumber.get(primaryBlue) ?? null,
      bluePool: bluePoolSorted,
      redMetrics,
      redTargets,
      redPool,
      lastRedSet,
      primaryRed: primaryRed.numbers,
      redStatsByNumber,
      primaryBlue,
    }),
  }
}

function toDraw(entry) {
  const numbers = entry?.numbers
  if (!Array.isArray(numbers) || numbers.length < RED_COUNT + BLUE_COUNT) {
    return null
  }

  const red = numbers.slice(0, RED_COUNT).map(Number)
  const blue = numbers.slice(RED_COUNT, RED_COUNT + BLUE_COUNT).map(Number)
  const redValid = red.every(
    (value) => Number.isInteger(value) && value >= RED_MIN && value <= RED_MAX,
  )
  const blueValid = blue.every(
    (value) => Number.isInteger(value) && value >= BLUE_MIN && value <= BLUE_MAX,
  )
  if (!redValid || !blueValid) {
    return null
  }

  return {
    red: [...red].sort((left, right) => left - right),
    blue,
  }
}

function pickRedCombination(pool, ranking, targets, lastRedSet) {
  const statByNumber = new Map(ranking.map((stat) => [stat.number, stat]))
  const numbers = [...pool].sort((left, right) => left - right)
  if (numbers.length < RED_COUNT) {
    return null
  }

  let best = null
  let bestSumDistance = Number.POSITIVE_INFINITY

  for (let first = 0; first < numbers.length - 5; first += 1) {
    for (let second = first + 1; second < numbers.length - 4; second += 1) {
      for (let third = second + 1; third < numbers.length - 3; third += 1) {
        for (let fourth = third + 1; fourth < numbers.length - 2; fourth += 1) {
          for (let fifth = fourth + 1; fifth < numbers.length - 1; fifth += 1) {
            for (let sixth = fifth + 1; sixth < numbers.length; sixth += 1) {
              const combination = [
                numbers[first],
                numbers[second],
                numbers[third],
                numbers[fourth],
                numbers[fifth],
                numbers[sixth],
              ]
              const metrics = computeNumberIndicators(combination, {
                bigMin: RED_BIG_MIN,
                zoneLimits: RED_ZONE_LIMITS,
              })
              if (!metrics) {
                continue
              }
              const baseScore =
                combination.reduce(
                  (total, number) => total + (statByNumber.get(number)?.score ?? 0),
                  0,
                ) / combination.length
              const sumDistance = Math.abs(metrics.sum - targets.averageSum)
              const zoneDistance =
                Math.abs(metrics.zones[0] - targets.averageZones[0]) +
                Math.abs(metrics.zones[1] - targets.averageZones[1]) +
                Math.abs(metrics.zones[2] - targets.averageZones[2])
              const overlap = combination.filter((number) => lastRedSet.has(number)).length
              // 组合分：平均评分占主导，和值 / 跨度 / 奇偶 / 大小 / 三区 / 连号 / 重号做软约束
              const score =
                baseScore * 1.6 -
                sumDistance / 45 -
                Math.abs(metrics.span - targets.averageSpan) / 12 -
                Math.abs(metrics.odd - targets.averageOdd) * 0.08 -
                Math.abs(metrics.big - targets.averageBig) * 0.08 -
                zoneDistance * 0.12 -
                metrics.consecutive * 0.06 -
                Math.max(0, overlap - 2) * 0.08

              if (
                !best ||
                score > best.score + 1e-9 ||
                (Math.abs(score - best.score) <= 1e-9 && sumDistance < bestSumDistance - 1e-9)
              ) {
                best = { numbers: combination, metrics, score }
                bestSumDistance = sumDistance
              }
            }
          }
        }
      }
    }
  }

  return best
}

function buildReasons({
  windows,
  redHot,
  redOverdue,
  blueStats,
  bluePool,
  redMetrics,
  redTargets,
  redPool,
  lastRedSet,
  primaryRed,
  redStatsByNumber,
  primaryBlue,
}) {
  const expectedRecentRed = (windows.recent * RED_COUNT) / (RED_MAX - RED_MIN + 1)
  const averageGapRed = (RED_MAX - RED_MIN + 1) / RED_COUNT
  const hotText = redHot
    ? `${pad2(redHot.number)} 近 ${windows.recent} 期出现 ${redHot.recentCount} 次（均值 ${expectedRecentRed.toFixed(1)} 次）`
    : '样本不足'
  const overdueText = redOverdue
    ? `${pad2(redOverdue.number)} 已遗漏 ${redOverdue.missSpan} 期（平均 ${averageGapRed.toFixed(1)} 期一出）`
    : '暂无'

  const repeats = redPool.filter((number) => lastRedSet.has(number)).length
  const primaryHot = [...primaryRed]
    .sort((left, right) => {
      const leftStat = redStatsByNumber.get(left)
      const rightStat = redStatsByNumber.get(right)
      return (
        (rightStat?.recentCount ?? 0) - (leftStat?.recentCount ?? 0) ||
        left - right
      )
    })
    .slice(0, 3)
    .map((number) => pad2(number))
    .join(' / ')

  return [
    `红球热号 ${hotText}；${overdueText}。`,
    `主推红球 ${primaryRed.map((number) => pad2(number)).join(' ')}，和值 ${redMetrics.sum}、跨度 ${redMetrics.span}，奇偶 ${formatOddEven(redMetrics)}、大小 ${formatBigSmall(redMetrics)}、三区 ${formatZones(redMetrics)}；近 ${windows.recent} 期均值 ${redTargets.averageSum.toFixed(1)} / ${redTargets.averageSpan.toFixed(1)}。`,
    `红球池按一区 1–11、二区 12–22、三区 23–33 各取 4 码，兼顾区间均衡与冷热回补；池内上一期重号 ${repeats} 个，主推中近 ${windows.recent} 期较热的号码为 ${primaryHot}。`,
    `蓝球主推 ${pad2(primaryBlue)}${blueStats ? `，近 ${windows.recent} 期出现 ${blueStats.recentCount} 次、当前遗漏 ${blueStats.missSpan} 期` : ''}；蓝球 ${BLUE_POOL_SIZE} 码池：${bluePool.map((number) => pad2(number)).join(' / ')}。`,
  ]
}
