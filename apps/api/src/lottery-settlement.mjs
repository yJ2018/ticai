import { HttpError } from './lib.mjs'

/**
 * 彩票选号投注（单式 + 复式）：号码校验、注数计算与开奖判定（纯函数，可单测）。
 *
 * 号码结构：
 *   - 排列五 / 七星彩（位次型）：{ main: [[1,2], [5], [4], [4], [8]], extra: [] }
 *     每个位次一个数组；单式就是每个数组只有 1 个数字。
 *   - 超级大乐透（组合型）：{ main: [1,6,10,15,32], extra: [3,8] }
 *     前区至少 5 个、后区至少 2 个；单式就是恰好 5 + 2。
 *
 * 注数：
 *   - 位次型：各位长度的乘积；
 *   - 大乐透：C(前区个数, 5) × C(后区个数, 2)。
 *
 * 判定：
 *   - 排列五 / 七星彩：按位比对，全中记一等奖（低奖项规则未建模）；
 *   - 大乐透：按官方九个奖级，返回中奖注数与奖级列表；
 *   - 浮动奖金不代算（payout 恒为 0），以官方公告为准。
 */

export const LOTTERY_GAMES = {
  pl5: {
    key: 'pl5',
    gameNo: '350133',
    name: '排列5',
    positional: true,
    mainCount: 5,
    mainMax: 9,
    extraCount: 0,
    extraMax: 0,
  },
  qxc: {
    key: 'qxc',
    gameNo: '04',
    name: '七星彩',
    positional: true,
    mainCount: 7,
    mainMax: 9,
    extraCount: 0,
    extraMax: 0,
  },
  dlt: {
    key: 'dlt',
    gameNo: '85',
    name: '超级大乐透',
    positional: false,
    mainCount: 5,
    mainMax: 35,
    extraCount: 2,
    extraMax: 12,
  },
}

/** 单张彩票的注数上限：1000 注 = 2000 元，避免误选几十万注。 */
export const MAX_LOTTERY_UNITS = 1000

const BY_GAME_NO = new Map(Object.values(LOTTERY_GAMES).map((game) => [game.gameNo, game]))

export function resolveLotteryGame(value) {
  const raw = String(value ?? '').trim()
  if (!raw) {
    return null
  }
  return LOTTERY_GAMES[raw.toLowerCase()] ?? BY_GAME_NO.get(raw) ?? null
}

/** 组合数 C(n, k)，n 不会很大（≤35），直接乘除即可。 */
export function combinationCount(n, k) {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || n < k) {
    return 0
  }
  let result = 1
  for (let index = 1; index <= k; index += 1) {
    result = (result * (n - k + index)) / index
  }
  return Math.round(result)
}

function toIntegerArray(value) {
  if (!Array.isArray(value)) {
    return null
  }
  return value.map((item) => Number(item))
}

function isIntegerInRange(values, min, max) {
  return values.every((item) => Number.isInteger(item) && item >= min && item <= max)
}

function normalizePositional(game, raw) {
  const groups = Array.isArray(raw?.main) ? raw.main : null
  if (!groups || groups.length !== game.mainCount || !groups.every((group) => Array.isArray(group))) {
    throw new HttpError(400, `${game.name}需要按 ${game.mainCount} 个位次选号`)
  }

  const main = groups.map((group, index) => {
    const digits = toIntegerArray(group)
    if (!digits || digits.length === 0) {
      throw new HttpError(400, `第 ${index + 1} 位至少要选 1 个数字`)
    }
    if (!isIntegerInRange(digits, 0, 9)) {
      throw new HttpError(400, `${game.name}号码必须是 0–9 的整数`)
    }
    return Array.from(new Set(digits)).sort((left, right) => left - right)
  })

  const units = main.reduce((product, digits) => product * digits.length, 1)
  return { numbers: { main, extra: [] }, units }
}

function normalizeDlt(game, raw) {
  const main = toIntegerArray(raw?.main)
  if (!main || main.length < game.mainCount || main.length > game.mainMax) {
    throw new HttpError(400, `${game.name}前区至少选 ${game.mainCount} 个（最多 ${game.mainMax} 个）`)
  }
  if (!isIntegerInRange(main, 1, game.mainMax)) {
    throw new HttpError(400, `${game.name}前区号码必须是 1–${game.mainMax} 的整数`)
  }

  const extra = toIntegerArray(raw?.extra)
  if (!extra || extra.length < game.extraCount || extra.length > game.extraMax) {
    throw new HttpError(400, `${game.name}后区至少选 ${game.extraCount} 个（最多 ${game.extraMax} 个）`)
  }
  if (!isIntegerInRange(extra, 1, game.extraMax)) {
    throw new HttpError(400, `${game.name}后区号码必须是 1–${game.extraMax} 的整数`)
  }

  const sortedMain = Array.from(new Set(main)).sort((left, right) => left - right)
  const sortedExtra = Array.from(new Set(extra)).sort((left, right) => left - right)
  if (sortedMain.length !== main.length) {
    throw new HttpError(400, `${game.name}前区号码不能重复`)
  }
  if (sortedExtra.length !== extra.length) {
    throw new HttpError(400, `${game.name}后区号码不能重复`)
  }

  const units = combinationCount(sortedMain.length, game.mainCount) * combinationCount(sortedExtra.length, game.extraCount)
  return { numbers: { main: sortedMain, extra: sortedExtra }, units }
}

/**
 * 校验并归一化号码。
 *
 * @returns {{ numbers: { main: number[] | number[][], extra: number[] }, units: number, mode: 'single'|'multiple' }}
 */
export function normalizeLotteryNumbers(gameKey, raw) {
  const game = LOTTERY_GAMES[gameKey]
  if (!game) {
    throw new HttpError(400, `不支持的彩种：${gameKey}`)
  }

  const result = game.positional ? normalizePositional(game, raw) : normalizeDlt(game, raw)
  return {
    ...result,
    mode: result.units > 1 ? 'multiple' : 'single',
  }
}

const DLT_TIERS = [
  { tier: '一等奖', main: 5, extra: 2 },
  { tier: '二等奖', main: 5, extra: 1 },
  { tier: '三等奖', main: 5, extra: 0 },
  { tier: '四等奖', main: 4, extra: 2 },
  { tier: '五等奖', main: 4, extra: 1 },
  { tier: '六等奖', main: 3, extra: 2 },
  { tier: '七等奖', main: 4, extra: 0 },
  { tier: '八等奖', main: 3, extra: 1 },
  { tier: '八等奖', main: 2, extra: 2 },
  { tier: '九等奖', main: 3, extra: 0 },
  { tier: '九等奖', main: 2, extra: 1 },
  { tier: '九等奖', main: 1, extra: 2 },
  { tier: '九等奖', main: 0, extra: 2 },
]

/** 兼容旧数据：位次型曾经存成扁平数字数组。 */
function positionalGroups(numbers) {
  const main = Array.isArray(numbers?.main) ? numbers.main : []
  return main.map((item) => (Array.isArray(item) ? item : [item]))
}

function judgePositional(game, numbers, drawMain) {
  const groups = positionalGroups(numbers)
  const matchedMain = groups.map((digits, index) => digits.includes(drawMain[index]))
  const hits = { main: matchedMain.filter(Boolean).length, extra: 0 }
  const won = hits.main === game.mainCount
  return {
    status: won ? 'won' : 'lost',
    tier: won ? '一等奖' : null,
    tiers: won ? [{ tier: '一等奖', units: 1 }] : [],
    winningUnits: won ? 1 : 0,
    hits,
    matchedMain,
    matchedExtra: [],
  }
}

function judgeDlt(game, numbers, drawMain, drawExtra) {
  const front = Array.isArray(numbers?.main) ? numbers.main : []
  const back = Array.isArray(numbers?.extra) ? numbers.extra : []
  const frontHit = front.filter((value) => drawMain.includes(value)).length
  const backHit = back.filter((value) => drawExtra.includes(value)).length

  const tiers = []
  let winningUnits = 0
  for (const tier of DLT_TIERS) {
    const frontWays =
      combinationCount(frontHit, tier.main) * combinationCount(front.length - frontHit, game.mainCount - tier.main)
    const backWays =
      combinationCount(backHit, tier.extra) * combinationCount(back.length - backHit, game.extraCount - tier.extra)
    const units = frontWays * backWays
    if (units > 0) {
      const existing = tiers.find((item) => item.tier === tier.tier)
      if (existing) {
        existing.units += units
      } else {
        tiers.push({ tier: tier.tier, units })
      }
      winningUnits += units
    }
  }

  return {
    status: winningUnits > 0 ? 'won' : 'lost',
    tier: tiers[0]?.tier ?? null,
    tiers,
    winningUnits,
    hits: { main: frontHit, extra: backHit },
    matchedMain: front.map((value) => drawMain.includes(value)),
    matchedExtra: back.map((value) => drawExtra.includes(value)),
  }
}

/**
 * 判定一张彩票注单（单式与复式同一套逻辑）。
 *
 * @returns {{ status: 'pending'|'won'|'lost', tier: string|null, tiers: Array<{tier:string,units:number}>, winningUnits: number, hits: {main:number,extra:number}, matchedMain: boolean[], matchedExtra: boolean[], draw: null|{issue:string,drawDate:string,main:number[],extra:number[]} }}
 */
export function judgeLotteryBet(gameKey, numbers, draw) {
  const game = LOTTERY_GAMES[gameKey]
  const empty = {
    status: 'pending',
    tier: null,
    tiers: [],
    winningUnits: 0,
    hits: { main: 0, extra: 0 },
    matchedMain: [],
    matchedExtra: [],
    draw: null,
  }
  if (!game || !draw) {
    return empty
  }

  const drawMain = (draw.main_numbers ?? []).map(Number)
  const drawExtra = (draw.extra_numbers ?? []).map(Number)
  const judged = game.positional
    ? judgePositional(game, numbers, drawMain)
    : judgeDlt(game, numbers, drawMain, drawExtra)

  return {
    ...judged,
    draw: {
      issue: draw.issue ?? '',
      drawDate: draw.draw_date ? String(draw.draw_date).slice(0, 10) : '',
      main: drawMain,
      extra: drawExtra,
    },
  }
}
