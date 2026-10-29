import { HttpError } from './lib.mjs'

/**
 * 彩票选号投注：号码校验与开奖判定（纯函数，可单测）。
 *
 * 目前支持单式：
 *   - 排列五：5 位 0–9
 *   - 七星彩：7 位 0–9
 *   - 超级大乐透：前区 5 个 1–35 + 后区 2 个 1–12
 *
 * 判定口径：
 *   - 排列五 / 七星彩：按位次逐位比对，全部命中才算中奖；
 *   - 大乐透：按官方九个奖级判定（前区命中数 + 后区命中数）；
 *   - 只判「中没中、第几等奖」，浮动奖金不在这里算（以官方公告为准）。
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

const BY_GAME_NO = new Map(Object.values(LOTTERY_GAMES).map((game) => [game.gameNo, game]))

export function resolveLotteryGame(value) {
  const raw = String(value ?? '').trim()
  if (!raw) {
    return null
  }
  return LOTTERY_GAMES[raw.toLowerCase()] ?? BY_GAME_NO.get(raw) ?? null
}

function toNumberArray(value) {
  if (!Array.isArray(value)) {
    return null
  }
  return value.map((item) => Number(item))
}

/**
 * 校验并归一化号码；不合法直接抛 400，客户端传什么都不信。
 * 大乐透前区/后区会排序去重（顺序不影响中奖），排列五/七星彩保留位次顺序。
 */
export function normalizeLotteryNumbers(gameKey, raw) {
  const game = LOTTERY_GAMES[gameKey]
  if (!game) {
    throw new HttpError(400, `不支持的彩种：${gameKey}`)
  }

  const mainMin = game.positional ? 0 : 1
  const main = toNumberArray(raw?.main)
  if (!main || main.length !== game.mainCount) {
    throw new HttpError(400, `${game.name}需要选 ${game.mainCount} 个号码`)
  }
  if (!main.every((item) => Number.isInteger(item) && item >= mainMin && item <= game.mainMax)) {
    throw new HttpError(400, `${game.name}号码必须是 ${mainMin}–${game.mainMax} 的整数`)
  }

  let extra = []
  if (game.extraCount > 0) {
    const rawExtra = toNumberArray(raw?.extra)
    if (!rawExtra || rawExtra.length !== game.extraCount) {
      throw new HttpError(400, `${game.name}需要选 ${game.extraCount} 个后区号码`)
    }
    if (!rawExtra.every((item) => Number.isInteger(item) && item >= 1 && item <= game.extraMax)) {
      throw new HttpError(400, `${game.name}后区号码必须是 1–${game.extraMax} 的整数`)
    }
    extra = rawExtra
  }

  if (game.positional) {
    return { main, extra: [] }
  }

  const sortedMain = Array.from(new Set(main)).sort((left, right) => left - right)
  const sortedExtra = Array.from(new Set(extra)).sort((left, right) => left - right)
  if (sortedMain.length !== game.mainCount) {
    throw new HttpError(400, `${game.name}前区号码不能重复`)
  }
  if (sortedExtra.length !== game.extraCount) {
    throw new HttpError(400, `${game.name}后区号码不能重复`)
  }
  return { main: sortedMain, extra: sortedExtra }
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

function dltTier(mainHits, extraHits) {
  return DLT_TIERS.find((item) => item.main === mainHits && item.extra === extraHits)?.tier ?? null
}

function intersectCount(picked, drawn) {
  const drawnSet = new Set(drawn)
  return picked.filter((item) => drawnSet.has(item)).length
}

/**
 * 判定一张彩票注单。
 *
 * @returns {{ status: 'pending'|'won'|'lost', tier: string|null, hits: {main:number, extra:number}, matchedMain: boolean[], draw: null|{issue:string, drawDate:string, main:number[], extra:number[]} }}
 */
export function judgeLotteryBet(gameKey, numbers, draw) {
  const game = LOTTERY_GAMES[gameKey]
  if (!game) {
    return { status: 'pending', tier: null, hits: { main: 0, extra: 0 }, matchedMain: [], draw: null }
  }
  if (!draw) {
    return { status: 'pending', tier: null, hits: { main: 0, extra: 0 }, matchedMain: [], draw: null }
  }

  const drawMain = (draw.main_numbers ?? []).map(Number)
  const drawExtra = (draw.extra_numbers ?? []).map(Number)
  const pickedMain = (numbers?.main ?? []).map(Number)
  const pickedExtra = (numbers?.extra ?? []).map(Number)

  const matchedMain = game.positional
    ? pickedMain.map((value, index) => value === drawMain[index])
    : pickedMain.map((value) => drawMain.includes(value))

  const hits = {
    main: matchedMain.filter(Boolean).length,
    extra: game.extraCount > 0 ? intersectCount(pickedExtra, drawExtra) : 0,
  }

  let tier = null
  if (game.positional) {
    tier = hits.main === game.mainCount ? '一等奖' : null
  } else {
    tier = dltTier(hits.main, hits.extra)
  }

  return {
    status: tier ? 'won' : 'lost',
    tier,
    hits,
    matchedMain,
    draw: {
      issue: draw.issue ?? '',
      drawDate: draw.draw_date ? String(draw.draw_date).slice(0, 10) : '',
      main: drawMain,
      extra: drawExtra,
    },
  }
}
