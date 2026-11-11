/**
 * 双色球 / 快乐8 逐期指标。
 *
 * 与大乐透一样，走势图右侧跟一组逐期统计：
 * - 双色球红球：和值、跨度、奇偶比、大小比（18–33 : 1–17）、三区比（1–11 / 12–22 / 23–33），
 *   蓝球单独显示；
 * - 快乐8：和值、跨度、奇偶比、大小比（41–80 : 1–40）、四区比（1–20 / 21–40 / 41–60 / 61–80）、连号组数。
 */

export const SSQ_RED_MIN = 1
export const SSQ_RED_MAX = 33
export const SSQ_RED_COUNT = 6
export const SSQ_BLUE_MIN = 1
export const SSQ_BLUE_MAX = 16
export const SSQ_BIG_MIN = 18
export const SSQ_ZONE_LIMITS = [11, 22, 33] as const

export const KL8_MIN = 1
export const KL8_MAX = 80
export const KL8_COUNT = 20
export const KL8_BIG_MIN = 41
export const KL8_ZONE_LIMITS = [20, 40, 60, 80] as const

export type PoolIndicator = {
  sum: number
  span: number
  odd: number
  even: number
  big: number
  small: number
  zones: number[]
  consecutive: number
}

export type PoolIndicatorSummary = {
  sampleSize: number
  averageSum: number
  averageSpan: number
  averageOdd: number
  averageBig: number
  averageZones: number[]
  averageConsecutive: number
}

function zoneIndexOf(value: number, zoneLimits: readonly number[]) {
  for (let index = 0; index < zoneLimits.length; index += 1) {
    if (value <= zoneLimits[index]) {
      return index
    }
  }
  return zoneLimits.length - 1
}

function computeIndicators(
  numbers: readonly number[],
  { bigMin, zoneLimits }: { bigMin: number; zoneLimits: readonly number[] },
): PoolIndicator | null {
  if (numbers.length === 0) {
    return null
  }

  const sorted = [...numbers].sort((left, right) => left - right)
  let sum = 0
  let odd = 0
  let big = 0
  let min = sorted[0]
  let max = sorted[0]
  const zones = zoneLimits.map(() => 0)

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

function parseNumbers(
  numbers: readonly string[],
  { count, min, max }: { count: number; min: number; max: number },
): number[] | null {
  if (numbers.length < count) {
    return null
  }
  const parsed: number[] = []
  for (let index = 0; index < count; index += 1) {
    const value = Number(numbers[index])
    if (!Number.isInteger(value) || value < min || value > max) {
      return null
    }
    parsed.push(value)
  }
  return parsed
}

/** 双色球红球 6 个号码的逐期指标 */
export function getSsqRedIndicators(numbers: readonly string[]) {
  const parsed = parseNumbers(numbers, {
    count: SSQ_RED_COUNT,
    min: SSQ_RED_MIN,
    max: SSQ_RED_MAX,
  })
  return parsed
    ? computeIndicators(parsed, { bigMin: SSQ_BIG_MIN, zoneLimits: SSQ_ZONE_LIMITS })
    : null
}

/** 快乐8 每期 20 个号码的逐期指标 */
export function getKl8Indicators(numbers: readonly string[]) {
  const parsed = parseNumbers(numbers, { count: KL8_COUNT, min: KL8_MIN, max: KL8_MAX })
  return parsed
    ? computeIndicators(parsed, { bigMin: KL8_BIG_MIN, zoneLimits: KL8_ZONE_LIMITS })
    : null
}

export function summarizeIndicators(
  items: ReadonlyArray<PoolIndicator | null>,
): PoolIndicatorSummary | null {
  const valid = items.filter((item): item is PoolIndicator => item !== null)
  if (valid.length === 0) {
    return null
  }

  let sum = 0
  let span = 0
  let odd = 0
  let big = 0
  let consecutive = 0
  const zones = valid[0].zones.map(() => 0)

  for (const item of valid) {
    sum += item.sum
    span += item.span
    odd += item.odd
    big += item.big
    consecutive += item.consecutive
    item.zones.forEach((value, index) => {
      zones[index] += value
    })
  }

  const count = valid.length
  return {
    sampleSize: count,
    averageSum: sum / count,
    averageSpan: span / count,
    averageOdd: odd / count,
    averageBig: big / count,
    averageZones: zones.map((value) => value / count),
    averageConsecutive: consecutive / count,
  }
}

export function formatOddEven(indicators: PoolIndicator) {
  return `${indicators.odd}:${indicators.even}`
}

export function formatBigSmall(indicators: PoolIndicator) {
  return `${indicators.big}:${indicators.small}`
}

export function formatZones(indicators: PoolIndicator) {
  return indicators.zones.join(':')
}

export function formatAverage(value: number) {
  return Number.isFinite(value) ? value.toFixed(1) : '--'
}
