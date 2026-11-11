import { type LotteryGameKey } from '../api/betApi'

/**
 * 彩票玩法元数据。
 *
 * 选号弹层（LotteryBetPanel）与历史页的「一键加注」共用同一份号码上限，
 * 免得两处各写一套、改了一边忘了另一边。
 */
export type LotteryGameMeta = {
  name: string
  /** 位次型（排列五 / 七星彩）按位置选号；其余是号码池 */
  positional: boolean
  mainCount: number
  mainMax: number
  /** 位次型：每位最大号码（七星彩末位是 0–14） */
  positionMax: number[]
  extraCount: number
  extraMax: number
  /** 号码池彩种的区域名称（双色球：红球/蓝球；大乐透：前区/后区） */
  mainLabel: string
  extraLabel: string
  /** 单式注数：号码池超过这个个数就是复式 */
  singleMain: number
  singleExtra: number
  /** 快乐8 选十：必须正好选 10 个，不支持多于 10 个的复式 */
  fixedMain?: boolean
}

export const LOTTERY_GAME_META: Record<LotteryGameKey, LotteryGameMeta> = {
  pl5: {
    name: '排列5',
    positional: true,
    mainCount: 5,
    mainMax: 9,
    positionMax: [9, 9, 9, 9, 9],
    extraCount: 0,
    extraMax: 0,
    mainLabel: '号码',
    extraLabel: '',
    singleMain: 1,
    singleExtra: 0,
  },
  qxc: {
    name: '七星彩',
    positional: true,
    mainCount: 7,
    mainMax: 14,
    positionMax: [9, 9, 9, 9, 9, 9, 14],
    extraCount: 0,
    extraMax: 0,
    mainLabel: '号码',
    extraLabel: '',
    singleMain: 1,
    singleExtra: 0,
  },
  dlt: {
    name: '超级大乐透',
    positional: false,
    mainCount: 5,
    mainMax: 35,
    positionMax: [],
    extraCount: 2,
    extraMax: 12,
    mainLabel: '前区',
    extraLabel: '后区',
    singleMain: 5,
    singleExtra: 2,
  },
  ssq: {
    name: '双色球',
    positional: false,
    mainCount: 6,
    mainMax: 33,
    positionMax: [],
    extraCount: 1,
    extraMax: 16,
    mainLabel: '红球',
    extraLabel: '蓝球',
    singleMain: 6,
    singleExtra: 1,
  },
  kl8: {
    name: '快乐8',
    positional: false,
    mainCount: 10,
    mainMax: 80,
    positionMax: [],
    extraCount: 0,
    extraMax: 0,
    mainLabel: '选十号码',
    extraLabel: '',
    singleMain: 10,
    singleExtra: 0,
    fixedMain: true,
  },
}

/**
 * 把「组合参考」的拼接串拆回每位号码。
 *
 * 服务端的组合参考是 `各位号码依次拼接`：排列五 `"72097"`、七星彩 `"1234567"`；
 * 七星彩末位是 0–14，落到 10–14 时会多占一个字符（`"12345614"`）。
 * 所以前 n-1 位各取一个字符，剩下的全给末位，再按每位上限校验一遍。
 */
export function splitPositionalCombination(value: string, positionMax: number[]): number[] | null {
  const count = positionMax.length
  if (count === 0 || !/^\d+$/.test(value) || value.length < count) {
    return null
  }

  const digits: number[] = []
  for (let index = 0; index < count - 1; index += 1) {
    digits.push(Number(value[index]))
  }
  digits.push(Number(value.slice(count - 1)))

  const valid = digits.every(
    (digit, index) => Number.isInteger(digit) && digit >= 0 && digit <= positionMax[index],
  )
  return valid ? digits : null
}
