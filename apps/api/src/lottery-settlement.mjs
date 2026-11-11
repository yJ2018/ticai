import { HttpError } from './lib.mjs'

/**
 * 彩票选号投注（单式 + 复式）：号码校验、注数计算与开奖判定（纯函数，可单测）。
 *
 * 号码结构：
 *   - 排列五 / 七星彩（位次型）：{ main: [[1,2], [5], [4], [4], [8]], extra: [] }
 *     每个位次一个数组；单式就是每个数组只有 1 个数字。
 *   - 超级大乐透（前后区）：{ main: [1,6,10,15,32], extra: [3,8] }
 *   - 双色球（红蓝区）：{ main: [3,9,16,20,25,30], extra: [5] }
 *   - 快乐8（选十）：{ main: [1, 8, 12, … 共 10 个], extra: [] }
 *
 * 注数：
 *   - 位次型：各位长度的乘积；
 *   - 大乐透：C(前区个数, 5) × C(后区个数, 2)；
 *   - 双色球：C(红球个数, 6) × C(蓝球个数, 1)；
 *   - 快乐8：固定选十，单式 1 注（不支持多于 10 个号码的复式）。
 *
 * 判定：
 *   - 排列五 / 七星彩：按位比对，全中记一等奖（低奖项规则未建模）；
 *   - 大乐透：按官方九个奖级，返回中奖注数与奖级列表；
 *   - 双色球：按六个奖级，复式用组合数算各奖级注数；
 *   - 快乐8：按选十奖级（10/9/8/7/6/5/0 中）；
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
    mainMax: 14,
    /** 前六位 0–9，第七位 0–14（体彩官方：末位 15 个号码） */
    positionMax: [9, 9, 9, 9, 9, 9, 14],
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
    mainLabel: '前区',
    extraLabel: '后区',
    drawMain: 5,
    drawExtra: 2,
    singleMain: 5,
    singleExtra: 2,
  },
  ssq: {
    key: 'ssq',
    gameNo: 'ssq',
    name: '双色球',
    positional: false,
    mainCount: 6,
    mainMax: 33,
    extraCount: 1,
    extraMax: 16,
    mainLabel: '红球',
    extraLabel: '蓝球',
    drawMain: 6,
    drawExtra: 1,
    singleMain: 6,
    singleExtra: 1,
  },
  kl8: {
    key: 'kl8',
    gameNo: 'kl8',
    name: '快乐8',
    positional: false,
    mainCount: 10,
    mainMax: 80,
    extraCount: 0,
    extraMax: 0,
    mainLabel: '选十号码',
    extraLabel: '',
    drawMain: 20,
    drawExtra: 0,
    singleMain: 10,
    singleExtra: 0,
    /** 只支持「选十」：必须正好 10 个号码 */
    fixedMain: true,
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

/** 组合数 C(n, k)，n 不会很大（≤80），直接乘除即可。 */
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
    const max = game.positionMax?.[index] ?? game.mainMax
    if (!digits || digits.length === 0) {
      throw new HttpError(400, `第 ${index + 1} 位至少要选 1 个数字`)
    }
    if (!isIntegerInRange(digits, 0, max)) {
      throw new HttpError(400, `第 ${index + 1} 位号码必须是 0–${max} 的整数`)
    }
    return Array.from(new Set(digits)).sort((left, right) => left - right)
  })

  const units = main.reduce((product, digits) => product * digits.length, 1)
  return { numbers: { main, extra: [] }, units }
}

function normalizePool(game, raw) {
  const mainLabel = game.mainLabel ?? '主号码'
  const extraLabel = game.extraLabel ?? '特别号码'
  const main = toIntegerArray(raw?.main)
  if (!main) {
    throw new HttpError(400, `${game.name}号码格式不正确`)
  }

  if (game.fixedMain) {
    if (main.length !== game.mainCount) {
      throw new HttpError(400, `${game.name}选十必须正好选 ${game.mainCount} 个号码`)
    }
  } else if (main.length < game.mainCount || main.length > game.mainMax) {
    throw new HttpError(
      400,
      `${game.name}${mainLabel}至少选 ${game.mainCount} 个（最多 ${game.mainMax} 个）`,
    )
  }
  if (!isIntegerInRange(main, 1, game.mainMax)) {
    throw new HttpError(400, `${game.name}${mainLabel}号码必须是 1–${game.mainMax} 的整数`)
  }

  let extra = []
  if (game.extraCount > 0) {
    const rawExtra = toIntegerArray(raw?.extra)
    if (!rawExtra || rawExtra.length < game.extraCount || rawExtra.length > game.extraMax) {
      throw new HttpError(
        400,
        `${game.name}${extraLabel}至少选 ${game.extraCount} 个（最多 ${game.extraMax} 个）`,
      )
    }
    if (!isIntegerInRange(rawExtra, 1, game.extraMax)) {
      throw new HttpError(400, `${game.name}${extraLabel}号码必须是 1–${game.extraMax} 的整数`)
    }
    extra = rawExtra
  }

  const sortedMain = Array.from(new Set(main)).sort((left, right) => left - right)
  const sortedExtra = Array.from(new Set(extra)).sort((left, right) => left - right)
  if (sortedMain.length !== main.length) {
    throw new HttpError(400, `${game.name}${mainLabel}号码不能重复`)
  }
  if (sortedExtra.length !== extra.length) {
    throw new HttpError(400, `${game.name}${extraLabel}号码不能重复`)
  }

  const mainUnits = combinationCount(sortedMain.length, game.mainCount)
  const extraUnits = game.extraCount > 0 ? combinationCount(sortedExtra.length, game.extraCount) : 1
  const units = mainUnits * extraUnits
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

  const result = game.positional ? normalizePositional(game, raw) : normalizePool(game, raw)
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

const SSQ_TIERS = ['一等奖', '二等奖', '三等奖', '四等奖', '五等奖', '六等奖']
const KL8_TIERS = [
  '选十中十',
  '选十中九',
  '选十中八',
  '选十中七',
  '选十中六',
  '选十中五',
  '选十中零',
]

function ssqTier(red, blue) {
  if (red === 6 && blue === 1) return '一等奖'
  if (red === 6 && blue === 0) return '二等奖'
  if (red === 5 && blue === 1) return '三等奖'
  if ((red === 5 && blue === 0) || (red === 4 && blue === 1)) return '四等奖'
  if ((red === 4 && blue === 0) || (red === 3 && blue === 1)) return '五等奖'
  if ((red === 2 && blue === 1) || (red === 1 && blue === 1) || (red === 0 && blue === 1)) {
    return '六等奖'
  }
  return null
}

function kl8Tier(hits) {
  if (hits === 10) return '选十中十'
  if (hits === 9) return '选十中九'
  if (hits === 8) return '选十中八'
  if (hits === 7) return '选十中七'
  if (hits === 6) return '选十中六'
  if (hits === 5) return '选十中五'
  if (hits === 0) return '选十中零'
  return null
}

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
 * 双色球：红球池覆盖 r 个开奖号、蓝球池覆盖 b 个（0/1）。
 * 恰好包含 k 个开奖红球的 6 码组合数 = C(r,k) × C(n-r,6-k)；
 * 蓝球命中/未命中的组合数分别是 b / (m-b)。
 */
function judgeSsq(game, numbers, drawMain, drawExtra) {
  const red = Array.isArray(numbers?.main) ? numbers.main : []
  const blue = Array.isArray(numbers?.extra) ? numbers.extra : []
  const redHit = red.filter((value) => drawMain.includes(value)).length
  const blueHit = blue.filter((value) => drawExtra.includes(value)).length

  const tierUnits = new Map()
  for (let k = 0; k <= Math.min(6, redHit); k += 1) {
    const redWays = combinationCount(redHit, k) * combinationCount(red.length - redHit, 6 - k)
    if (redWays <= 0) {
      continue
    }
    for (const [blueMatch, blueWays] of [
      [1, combinationCount(blueHit, 1) * combinationCount(blue.length - blueHit, 0)],
      [0, combinationCount(blueHit, 0) * combinationCount(blue.length - blueHit, 1)],
    ]) {
      if (blueWays <= 0) {
        continue
      }
      const tier = ssqTier(k, blueMatch)
      if (!tier) {
        continue
      }
      tierUnits.set(tier, (tierUnits.get(tier) ?? 0) + redWays * blueWays)
    }
  }

  const tiers = SSQ_TIERS.filter((tier) => tierUnits.has(tier)).map((tier) => ({
    tier,
    units: tierUnits.get(tier),
  }))
  const winningUnits = tiers.reduce((sum, item) => sum + item.units, 0)

  return {
    status: winningUnits > 0 ? 'won' : 'lost',
    tier: tiers[0]?.tier ?? null,
    tiers,
    winningUnits,
    hits: { main: redHit, extra: blueHit },
    matchedMain: red.map((value) => drawMain.includes(value)),
    matchedExtra: blue.map((value) => drawExtra.includes(value)),
  }
}

/** 快乐8 选十：10 个号码命中 10/9/8/7/6/5/0 个有奖，1–4 个无奖。 */
function judgeKl8(game, numbers, drawMain) {
  const picks = Array.isArray(numbers?.main) ? numbers.main : []
  const hits = picks.filter((value) => drawMain.includes(value)).length
  const tier = kl8Tier(hits)
  return {
    status: tier ? 'won' : 'lost',
    tier,
    tiers: tier ? [{ tier, units: 1 }] : [],
    winningUnits: tier ? 1 : 0,
    hits: { main: hits, extra: 0 },
    matchedMain: picks.map((value) => drawMain.includes(value)),
    matchedExtra: [],
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
  let judged
  if (game.positional) {
    judged = judgePositional(game, numbers, drawMain)
  } else if (game.key === 'dlt') {
    judged = judgeDlt(game, numbers, drawMain, drawExtra)
  } else if (game.key === 'ssq') {
    judged = judgeSsq(game, numbers, drawMain, drawExtra)
  } else if (game.key === 'kl8') {
    judged = judgeKl8(game, numbers, drawMain)
  } else {
    judged = { ...empty, status: 'lost' }
  }

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
