/**
 * 号码池型彩种的公共统计工具（双色球 / 快乐8）。
 *
 * 大乐透有自己的一套 5+2 推演（dlt-recommendation.mjs），这里只抽福彩两个彩种
 * 都会用到的「逐号码评分、分区池、形态指标、区间目标」，
 * 让两套推荐共用同一份口径，Python 版逐行对拍。
 */

export const POOL_WINDOWS = Object.freeze({ short: 10, recent: 30, long: 100 })

/**
 * 逐号码评分。
 *
 * - 近 10 / 30 / 100 期频次按期望次数归一，热号得分高；
 * - 遗漏值按「平均多少期一出」归一，最多计 3 倍期望，避免极冷号霸榜；
 * - 可选 repeatSet / neighborSet：上一期重号与邻号给一点小加成（双色球用）。
 *
 * @param {number[][]} series 每期号码数组，最新在前
 * @param {{min:number,max:number,pickPerDraw:number,windows:{short:number,recent:number,long:number},repeatSet?:Set<number>|null,neighborSet?:Set<number>|null}} options
 */
export function rankPoolNumbers(
  series,
  { min, max, pickPerDraw, windows, repeatSet = null, neighborSet = null },
) {
  const domainSize = max - min + 1
  const counts = Array.from({ length: domainSize }, () => ({
    short: 0,
    recent: 0,
    long: 0,
    miss: null,
    repeat: 0,
    neighbor: 0,
  }))

  for (let index = 0; index < series.length; index += 1) {
    for (const number of series[index]) {
      const count = counts[number - min]
      if (!count) {
        continue
      }
      if (index < windows.long) {
        count.long += 1
      }
      if (index < windows.short) {
        count.short += 1
      }
      if (index < windows.recent) {
        count.recent += 1
      }
      if (count.miss === null) {
        count.miss = index
      }
      if (index === 0) {
        if (repeatSet?.has(number)) {
          count.repeat = 1
        }
        if (neighborSet?.has(number)) {
          count.neighbor = 1
        }
      }
    }
  }

  const expectedShort = Math.max((windows.short * pickPerDraw) / domainSize, 1e-6)
  const expectedRecent = Math.max((windows.recent * pickPerDraw) / domainSize, 1e-6)
  const expectedLong = Math.max((windows.long * pickPerDraw) / domainSize, 1e-6)
  const expectedGap = domainSize / pickPerDraw

  return counts
    .map((count, index) => {
      const number = min + index
      const missSpan = count.miss ?? windows.long
      // 频次 / 遗漏权重：近 10 期 30%、近 30 期 25%、近 100 期 20%、遗漏 25%
      let score =
        0.3 * (count.short / expectedShort) +
        0.25 * (count.recent / expectedRecent) +
        0.2 * (count.long / expectedLong) +
        0.25 * Math.min(missSpan / expectedGap, 3)
      // 双色球：上一期重号 / 邻号是常用的软信号，权重故意压得很低
      score += 0.06 * count.repeat + 0.04 * count.neighbor
      return {
        number,
        score,
        shortCount: count.short,
        recentCount: count.recent,
        longCount: count.long,
        missSpan,
        repeat: count.repeat,
        neighbor: count.neighbor,
      }
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.missSpan - left.missSpan ||
        left.number - right.number,
    )
}

/** 号码属于第几区（0 起）；zoneLimits 是每区的上界，如 [11,22,33]。 */
export function zoneIndexOf(number, zoneLimits) {
  for (let index = 0; index < zoneLimits.length; index += 1) {
    if (number <= zoneLimits[index]) {
      return index
    }
  }
  return zoneLimits.length - 1
}

/** 每个区取评分最高的 perZone 个号码，返回升序号码池。 */
export function pickZonePool(ranked, { zoneLimits, perZone }) {
  const byZone = Array.from({ length: zoneLimits.length }, () => [])
  for (const stat of ranked) {
    byZone[zoneIndexOf(stat.number, zoneLimits)].push(stat)
  }

  return byZone
    .flatMap((stats) => stats.slice(0, perZone))
    .map((stat) => stat.number)
    .sort((left, right) => left - right)
}

/**
 * 单期号码形态。
 * @param {number[]} numbers 已排序或未排序的号码
 * @param {{bigMin:number, zoneLimits:number[]}} options
 */
export function computeNumberIndicators(numbers, { bigMin, zoneLimits }) {
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return null
  }

  let sum = 0
  let odd = 0
  let big = 0
  let min = numbers[0]
  let max = numbers[0]
  const zones = Array.from({ length: zoneLimits.length }, () => 0)
  const sorted = [...numbers].sort((left, right) => left - right)

  for (const value of sorted) {
    sum += value
    if (value % 2 === 1) {
      odd += 1
    }
    if (value >= bigMin) {
      big += 1
    }
    if (value < min) {
      min = value
    }
    if (value > max) {
      max = value
    }
    zones[zoneIndexOf(value, zoneLimits)] += 1
  }

  let consecutive = 0
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1] + 1) {
      consecutive += 1
    }
  }

  return {
    sum,
    span: max - min,
    odd,
    even: sorted.length - odd,
    big,
    small: sorted.length - big,
    zones,
    consecutive,
  }
}

/** 近 N 期的形态目标（均值 + 众数），用于组合软约束与文案。 */
export function summarizeTargets(series, { window, pickCount, bigMin, zoneLimits }) {
  const sample = series.slice(0, Math.min(window, series.length))
  const oddEvenCounts = new Map()
  const bigSmallCounts = new Map()
  const zoneCounts = new Map()
  let validSamples = 0
  let sum = 0
  let span = 0
  let odd = 0
  let big = 0
  const zones = Array.from({ length: zoneLimits.length }, () => 0)

  for (const numbers of sample) {
    const indicators = computeNumberIndicators(numbers, { bigMin, zoneLimits })
    if (!indicators) {
      continue
    }
    validSamples += 1
    sum += indicators.sum
    span += indicators.span
    odd += indicators.odd
    big += indicators.big
    for (let index = 0; index < zoneLimits.length; index += 1) {
      zones[index] += indicators.zones[index]
    }
    increment(oddEvenCounts, `${indicators.odd}:${indicators.even}`)
    increment(bigSmallCounts, `${indicators.big}:${indicators.small}`)
    increment(zoneCounts, indicators.zones.join(':'))
  }

  const divisor = validSamples || 1
  const averageZones = zones.map((value) => value / divisor)

  return {
    averageSum: sum / divisor,
    averageSpan: span / divisor,
    averageOdd: odd / divisor,
    averageBig: big / divisor,
    averageZones,
    commonOddEven: mostCommon(
      oddEvenCounts,
      `${roundHalf(pickCount / 2)}:${pickCount - roundHalf(pickCount / 2)}`,
    ),
    commonBigSmall: mostCommon(
      bigSmallCounts,
      `${roundHalf(pickCount / 2)}:${pickCount - roundHalf(pickCount / 2)}`,
    ),
    commonZones: mostCommon(
      zoneCounts,
      averageZones.map((value) => roundHalf(value)).join(':'),
    ),
  }
}

/**
 * 按近 N 期各区均值把 targetCount 个名额分配到各区。
 * 最大余数法，余数相同取区号小的；保证总和严格等于 targetCount。
 */
export function allocateZones(averageZones, targetCount) {
  const total = averageZones.reduce((sum, value) => sum + value, 0) || 1
  const exact = averageZones.map((value) => (value / total) * targetCount)
  const counts = exact.map((value) => Math.floor(value))
  let remaining = targetCount - counts.reduce((sum, value) => sum + value, 0)

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index)

  for (let index = 0; index < order.length && remaining > 0; index += 1) {
    counts[order[index].index] += 1
    remaining -= 1
  }

  // 极端情况下（区数 > targetCount）仍要凑满，按区号补
  let cursor = 0
  while (remaining > 0 && counts.length > 0) {
    counts[cursor % counts.length] += 1
    cursor += 1
    remaining -= 1
  }

  return counts
}

export function formatOddEven(indicators) {
  return `${indicators.odd}:${indicators.even}`
}

export function formatBigSmall(indicators) {
  return `${indicators.big}:${indicators.small}`
}

export function formatZones(indicators) {
  return indicators.zones.join(':')
}

export function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 四舍五入到整数，避免 JS Math.round 与 Python round 的 .5 差异 */
export function roundHalf(value) {
  return Math.floor(value + 0.5)
}

function increment(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

function mostCommon(counts, fallback) {
  let bestKey = fallback
  let bestCount = 0
  for (const [key, count] of counts) {
    if (count > bestCount || (count === bestCount && key < bestKey)) {
      bestKey = key
      bestCount = count
    }
  }
  return bestKey
}
