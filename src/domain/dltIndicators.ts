/**
 * 大乐透前区逐期指标。
 *
 * 业界走势图右侧通常跟着一组逐期统计：和值、跨度、奇偶比、大小比、三区比。
 * 这里集中定义口径，页面（桌面右栏 / 移动端卡片）只负责展示：
 * - 和值：前区 5 个号码之和，范围 15–165
 * - 跨度：最大号 − 最小号，范围 4–34
 * - 奇偶比：奇数个数 : 偶数个数
 * - 大小比：大号（18–35） : 小号（1–17）
 * - 三区比：一区 1–12 : 二区 13–24 : 三区 25–35
 */

const FRONT_BALL_COUNT = 5
const MAX_FRONT_NUMBER = 35
/** 前区大小分界：18–35 为大号，1–17 为小号 */
const BIG_NUMBER_MIN = 18
/** 三区上界：1–12 / 13–24 / 25–35 */
const ZONE_UPPER_LIMITS = [12, 24, 35] as const

export type DltFrontIndicators = {
  sum: number
  span: number
  odd: number
  even: number
  big: number
  small: number
  /** 一区 / 二区 / 三区号码个数 */
  zones: [number, number, number]
}

export type DltFrontIndicatorSummary = {
  sampleSize: number
  averageSum: number
  averageSpan: number
  averageOdd: number
  averageBig: number
  averageZones: [number, number, number]
}

/** 解析前区 5 个号码；号码缺失或越界时返回 null，交给页面显示 "--" */
export function getDltFrontIndicators(numbers: readonly string[]): DltFrontIndicators | null {
  if (numbers.length < FRONT_BALL_COUNT) {
    return null
  }

  const frontNumbers: number[] = []
  for (let index = 0; index < FRONT_BALL_COUNT; index += 1) {
    const value = Number(numbers[index])
    if (!Number.isInteger(value) || value < 1 || value > MAX_FRONT_NUMBER) {
      return null
    }
    frontNumbers.push(value)
  }

  let sum = 0
  let odd = 0
  let big = 0
  const zones: [number, number, number] = [0, 0, 0]
  let min = frontNumbers[0]
  let max = frontNumbers[0]

  for (const value of frontNumbers) {
    sum += value
    if (value % 2 === 1) {
      odd += 1
    }
    if (value >= BIG_NUMBER_MIN) {
      big += 1
    }
    if (value < min) {
      min = value
    }
    if (value > max) {
      max = value
    }

    const zoneIndex = ZONE_UPPER_LIMITS.findIndex((upperLimit) => value <= upperLimit)
    zones[zoneIndex >= 0 ? zoneIndex : ZONE_UPPER_LIMITS.length - 1] += 1
  }

  return {
    sum,
    span: max - min,
    odd,
    even: FRONT_BALL_COUNT - odd,
    big,
    small: FRONT_BALL_COUNT - big,
    zones,
  }
}

/** 汇总一页数据，供右栏顶部显示「本页均值」 */
export function summarizeDltFrontIndicators(
  items: ReadonlyArray<DltFrontIndicators | null>,
): DltFrontIndicatorSummary | null {
  const validItems = items.filter((item): item is DltFrontIndicators => item !== null)
  if (validItems.length === 0) {
    return null
  }

  let sum = 0
  let span = 0
  let odd = 0
  let big = 0
  let zone0 = 0
  let zone1 = 0
  let zone2 = 0

  for (const item of validItems) {
    sum += item.sum
    span += item.span
    odd += item.odd
    big += item.big
    zone0 += item.zones[0]
    zone1 += item.zones[1]
    zone2 += item.zones[2]
  }

  const sampleSize = validItems.length
  return {
    sampleSize,
    averageSum: sum / sampleSize,
    averageSpan: span / sampleSize,
    averageOdd: odd / sampleSize,
    averageBig: big / sampleSize,
    averageZones: [zone0 / sampleSize, zone1 / sampleSize, zone2 / sampleSize],
  }
}

/** 奇数 : 偶数 */
export function formatDltOddEven(indicators: DltFrontIndicators) {
  return `${indicators.odd}:${indicators.even}`
}

/** 大号 : 小号 */
export function formatDltBigSmall(indicators: DltFrontIndicators) {
  return `${indicators.big}:${indicators.small}`
}

/** 一区 : 二区 : 三区 */
export function formatDltZones(indicators: DltFrontIndicators) {
  return indicators.zones.join(':')
}

/** 均值保留 1 位小数，用于右栏顶部的汇总行 */
export function formatDltAverage(value: number) {
  return Number.isFinite(value) ? value.toFixed(1) : '--'
}
