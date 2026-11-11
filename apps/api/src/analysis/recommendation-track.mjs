import { analyzeDltRecommendation } from './dlt-recommendation.mjs'
import { analyzeKl8Recommendation } from './kl8-recommendation.mjs'
import { analyzeSsqRecommendation } from './ssq-recommendation.mjs'

/**
 * 号码池型彩种的逐期推荐命中归档（walk-forward）。
 *
 * 位次型彩种用 lottery_prediction_track（逐位 Top1/Top3）；
 * 大乐透 / 双色球 / 快乐8 的推荐是「号码池」，命中口径不同，所以单独一套：
 *   - 大乐透：主推前区 5 + 后区 2，按九个奖级定档；
 *   - 双色球：红球 12 码池 + 蓝球 4 码池，记录覆盖几个开奖号，
 *     主推 6+1 单注用于定档，复式票按组合数算出各奖级注数；
 *   - 快乐8：选十 10 码，命中 0–10 个，按选十奖级定档。
 *
 * 第 N 期的推荐只使用第 1..N-1 期数据（through_issue 记录截点），
 * 与线上「开奖前给出的下一期参考」完全同一套打分，不做偷看。
 */

export const RECOMMENDATION_TRACK_VERSION = 'hits-1'
export const RECOMMENDATION_TRACK_WINDOWS = [30, 100, 300, 1000]
export const RECOMMENDATION_TRACK_RECENT_LIMIT = 1000
/** 默认只归档最近 300 期：够做窗口分析，又不会让首次回填变成全量重算 */
export const RECOMMENDATION_TRACK_LIMIT = 300
/** 少于 30 期不产生推荐（与各推演模块的最小样本一致） */
export const RECOMMENDATION_MIN_TRAINING = 30

const DLT_TIERS = [
  '一等奖',
  '二等奖',
  '三等奖',
  '四等奖',
  '五等奖',
  '六等奖',
  '七等奖',
  '八等奖',
  '九等奖',
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

/** 彩种 → 推演算法 */
export function recommendationKindForGame(game) {
  if (game.game_key === 'dlt') {
    return 'dlt'
  }
  if (game.game_key === 'ssq') {
    return 'ssq'
  }
  if (game.game_key === 'kl8') {
    return 'kl8'
  }
  return null
}

/**
 * @param {Array<{issue:string, issueSeq:number, drawDate:string, numbers:string[]}>} draws 最新在前
 * @param {{game:object, kind?:string, limit?:number, sinceSeq?:number, counters?:object|null, recent?:Array|null}} options
 */
export function buildRecommendationTrack(draws, options = {}) {
  const game = options.game
  const kind = options.kind ?? recommendationKindForGame(game)
  if (!kind || !['dlt', 'ssq', 'kl8'].includes(kind)) {
    throw new Error(`不支持的号码池推演：${kind}`)
  }

  const chronological = [...draws].sort((left, right) => left.issueSeq - right.issueSeq)
  const limit = clampInt(options.limit, RECOMMENDATION_TRACK_LIMIT, 1, 1000)
  const sinceSeq = toFiniteNumber(options.sinceSeq, 0)
  const counters = normalizeCounters(options.counters, game, kind)
  const recent = normalizeRecent(options.recent)

  const items = []
  let firstTracked = null
  let lastTracked = null

  const startIndex = Math.max(
    RECOMMENDATION_MIN_TRAINING,
    chronological.length - limit,
    0,
  )

  for (let index = startIndex; index < chronological.length; index += 1) {
    const target = chronological[index]
    if (!target || target.issueSeq <= sinceSeq) {
      continue
    }

    const prefix = chronological.slice(0, index)
    if (prefix.length < RECOMMENDATION_MIN_TRAINING) {
      continue
    }

    const recommendation = recommendForKind(kind, prefix)
    if (!recommendation) {
      continue
    }

    const prediction = buildPrediction(kind, recommendation)
    const actual = splitActual(target, game)
    if (!actual) {
      continue
    }

    const hits = countHits(prediction, actual)
    const ticket = buildTicket(kind, prediction, actual)
    const record = {
      issue: target.issue,
      issueSeq: target.issueSeq,
      drawDate: target.drawDate,
      throughIssue: prefix[prefix.length - 1]?.issue ?? null,
      throughIssueSeq: prefix[prefix.length - 1]?.issueSeq ?? null,
      prediction,
      actual,
      hits,
      ticket,
    }

    items.push(record)
    accumulate(counters, record)
    recent.push({
      issue: record.issue,
      seq: record.issueSeq,
      drawDate: record.drawDate,
      main: hits.main,
      extra: hits.extra,
      total: hits.total,
      tier: ticket.tier,
    })
    if (recent.length > RECOMMENDATION_TRACK_RECENT_LIMIT) {
      recent.splice(0, recent.length - RECOMMENDATION_TRACK_RECENT_LIMIT)
    }

    firstTracked ??= record
    lastTracked = record
  }

  return {
    version: RECOMMENDATION_TRACK_VERSION,
    kind,
    gameKey: game.game_key,
    limit,
    items,
    counters,
    recent,
    firstTracked,
    lastTracked,
    sinceSeq,
  }
}

/** 把累计计数与最近命中列表算成接口直出的统计对象 */
export function buildRecommendationHitStat({
  counters,
  recent,
  game,
  kind,
  configKey,
  sample,
}) {
  const normalized = normalizeCounters(counters, game, kind)
  const recentList = normalizeRecent(recent)
  const meta = gameShape(game, kind)
  const samples = normalized.samples

  const mainCaptureRate = safeRate(normalized.mainHits, samples * meta.actualMain)
  const extraCaptureRate = safeRate(normalized.extraHits, samples * meta.actualExtra)
  const mainLift = safeRate(mainCaptureRate, meta.mainPickRate)
  const extraLift = safeRate(extraCaptureRate, meta.extraPickRate)

  const windows = RECOMMENDATION_TRACK_WINDOWS.map((window) => {
    const slice = recentList.slice(-window)
    const windowSamples = slice.length
    const mainHits = slice.reduce((sum, item) => sum + item.main, 0)
    const extraHits = slice.reduce((sum, item) => sum + item.extra, 0)
    const wins = slice.filter((item) => item.tier).length
    return {
      window,
      samples: windowSamples,
      mainHits,
      extraHits,
      avgMainHits: safeRate(mainHits, windowSamples),
      avgExtraHits: safeRate(extraHits, windowSamples),
      avgTotalHits: safeRate(mainHits + extraHits, windowSamples),
      captureRate: safeRate(mainHits, windowSamples * meta.actualMain),
      lift: safeRate(
        safeRate(mainHits, windowSamples * meta.actualMain),
        meta.mainPickRate,
      ),
      winningIssues: wins,
      winningRate: safeRate(wins, windowSamples),
    }
  })

  const tierCounts = tierOrder(kind)
    .map((tier) => ({
      tier,
      count: normalized.tierCounts[tier] ?? 0,
      rate: safeRate(normalized.tierCounts[tier] ?? 0, samples),
    }))
    .filter((item) => item.count > 0)

  const winningIssues = normalized.winningIssues
  const bestTier = tierCounts.length > 0 ? tierCounts[0].tier : null

  return {
    version: RECOMMENDATION_TRACK_VERSION,
    kind,
    configKey,
    gameKey: game.game_key,
    shape: meta,
    baseline: {
      mainPickRate: meta.mainPickRate,
      extraPickRate: meta.extraPickRate,
      expectedMainHits: meta.expectedMainHits,
      expectedExtraHits: meta.expectedExtraHits,
      expectedTotalHits: meta.expectedMainHits + meta.expectedExtraHits,
    },
    sample: {
      ...sample,
      drawCount: samples,
    },
    overall: {
      samples,
      mainHits: normalized.mainHits,
      extraHits: normalized.extraHits,
      totalHits: normalized.mainHits + normalized.extraHits,
      avgMainHits: safeRate(normalized.mainHits, samples),
      avgExtraHits: safeRate(normalized.extraHits, samples),
      avgTotalHits: safeRate(normalized.mainHits + normalized.extraHits, samples),
      captureRate: mainCaptureRate,
      extraCaptureRate,
      lift: mainLift,
      extraLift,
      winningIssues,
      winningRate: safeRate(winningIssues, samples),
      bestTier,
    },
    windows,
    distribution: {
      main: normalized.mainDistribution.map((count, hits) => ({
        hits,
        count,
        rate: safeRate(count, samples),
      })),
      extra: normalized.extraDistribution.map((count, hits) => ({
        hits,
        count,
        rate: safeRate(count, samples),
      })),
    },
    tiers: tierCounts,
    rolling: recentList.slice(-120).map((item) => ({
      issue: item.issue,
      issueSeq: item.seq,
      drawDate: item.drawDate,
      main: item.main,
      extra: item.extra,
      total: item.total,
      tier: item.tier,
    })),
    recentCoverage: recentList.length,
  }
}

export function createEmptyRecommendationCounters(game, kind) {
  const shape = gameShape(game, kind)
  return {
    samples: 0,
    mainHits: 0,
    extraHits: 0,
    winningIssues: 0,
    tierCounts: {},
    mainDistribution: Array.from({ length: shape.actualMain + 1 }, () => 0),
    extraDistribution: Array.from({ length: shape.actualExtra + 1 }, () => 0),
  }
}

function recommendForKind(kind, prefixChronological) {
  // 推演函数统一要求「最新在前」
  const entries = [...prefixChronological]
    .reverse()
    .map((draw) => ({ numbers: draw.numbers }))

  if (kind === 'dlt') {
    return analyzeDltRecommendation(entries)
  }
  if (kind === 'ssq') {
    return analyzeSsqRecommendation(entries)
  }
  if (kind === 'kl8') {
    return analyzeKl8Recommendation(entries)
  }
  return null
}

function buildPrediction(kind, recommendation) {
  if (kind === 'dlt') {
    return {
      main: [...recommendation.picks.front],
      extra: [...recommendation.picks.back],
    }
  }
  if (kind === 'ssq') {
    return {
      // 命中覆盖口径用红球 12 码池 / 蓝球 4 码池
      main: [...recommendation.red.picks],
      extra: [...recommendation.blue.picks],
      // 单注定档用主推 6+1
      primaryMain: [...recommendation.red.primary],
      primaryExtra: [...recommendation.blue.primary],
    }
  }
  return {
    main: [...recommendation.picks.primary],
    extra: [],
    poolMain: [...recommendation.picks.pool],
    poolExtra: [],
  }
}

function splitActual(draw, game) {
  const numbers = Array.isArray(draw.numbers) ? draw.numbers.map(Number) : []
  const mainCount = Number(game.main_count ?? 0)
  const extraCount = Number(game.extra_count ?? 0)
  if (numbers.length < mainCount + extraCount) {
    return null
  }
  return {
    main: numbers.slice(0, mainCount),
    extra: numbers.slice(mainCount, mainCount + extraCount),
  }
}

function countHits(prediction, actual) {
  const mainSet = new Set(actual.main)
  const extraSet = new Set(actual.extra)
  const main = prediction.main.filter((number) => mainSet.has(number)).length
  const extra = prediction.extra.filter((number) => extraSet.has(number)).length
  return { main, extra, total: main + extra }
}

function buildTicket(kind, prediction, actual) {
  if (kind === 'ssq') {
    return buildSsqTicket(prediction, actual)
  }

  const tier = kind === 'dlt' ? dltTier(prediction.main, prediction.extra, actual) : kl8Tier(prediction.main, actual)
  return {
    tier,
    tiers: tier ? [{ tier, units: 1 }] : [],
    winningUnits: tier ? 1 : 0,
  }
}

/** 测试与巡检用：给一组推荐/实际，直接算命中与奖级 */
export function evaluateRecommendationTicket(kind, prediction, actual) {
  return buildTicket(kind, prediction, actual)
}

function dltTier(picks, back, actual) {
  const main = picks.filter((number) => actual.main.includes(number)).length
  const extra = back.filter((number) => actual.extra.includes(number)).length
  if (main === 5 && extra === 2) return '一等奖'
  if (main === 5 && extra === 1) return '二等奖'
  if (main === 5 && extra === 0) return '三等奖'
  if (main === 4 && extra === 2) return '四等奖'
  if (main === 4 && extra === 1) return '五等奖'
  if (main === 3 && extra === 2) return '六等奖'
  if (main === 4 && extra === 0) return '七等奖'
  if ((main === 3 && extra === 1) || (main === 2 && extra === 2)) return '八等奖'
  if (
    (main === 3 && extra === 0) ||
    (main === 1 && extra === 2) ||
    (main === 2 && extra === 1) ||
    (main === 0 && extra === 2)
  ) {
    return '九等奖'
  }
  return null
}

/** 快乐8 选十：命中 10/9/8/7/6/5/0 有奖，1–4 无奖 */
function kl8Tier(picks, actual) {
  const hits = picks.filter((number) => actual.main.includes(number)).length
  if (hits === 10) return '选十中十'
  if (hits === 9) return '选十中九'
  if (hits === 8) return '选十中八'
  if (hits === 7) return '选十中七'
  if (hits === 6) return '选十中六'
  if (hits === 5) return '选十中五'
  if (hits === 0) return '选十中零'
  return null
}

/**
 * 双色球复式：红球池 + 蓝球池的各奖级中奖注数。
 *
 * 红球命中 r 个、池 n 个时，恰好包含 k 个开奖号的 6 码组合数为
 * C(r,k) × C(n-r,6-k)；蓝球命中 1 个的组合数就是 1，未命中为池大小 − 1。
 */
function buildSsqTicket(prediction, actual) {
  const poolMain = prediction.main
  const poolExtra = prediction.extra
  const redHits = poolMain.filter((number) => actual.main.includes(number)).length
  const blueHit = poolExtra.some((number) => actual.extra.includes(number))
  const blueMatchUnits = blueHit ? 1 : 0
  const blueMissUnits = poolExtra.length - blueMatchUnits
  const tierUnits = new Map()

  for (let k = 0; k <= Math.min(6, redHits); k += 1) {
    const redUnits =
      combination(redHits, k) * combination(poolMain.length - redHits, 6 - k)
    if (redUnits <= 0) {
      continue
    }
    for (const [blueMatch, units] of [
      [1, blueMatchUnits],
      [0, blueMissUnits],
    ]) {
      if (units <= 0) {
        continue
      }
      const tier = ssqTier(k, blueMatch)
      if (!tier) {
        continue
      }
      tierUnits.set(tier, (tierUnits.get(tier) ?? 0) + redUnits * units)
    }
  }

  const tiers = SSQ_TIERS.filter((tier) => tierUnits.has(tier)).map((tier) => ({
    tier,
    units: tierUnits.get(tier),
  }))
  const winningUnits = tiers.reduce((sum, item) => sum + item.units, 0)

  // 主推 6+1 单注用来标「本期最好成绩」，复式注数放在 tiers 里
  const primaryMain = prediction.primaryMain ?? prediction.main
  const primaryExtra = prediction.primaryExtra ?? prediction.extra
  const primaryMainHits = primaryMain.filter((number) => actual.main.includes(number)).length
  const primaryBlueHit = primaryExtra.filter((number) => actual.extra.includes(number)).length
  const primaryTier = ssqTier(primaryMainHits, primaryBlueHit)
  const tier = primaryTier ?? tiers[0]?.tier ?? null

  return {
    tier,
    tiers,
    winningUnits,
  }
}

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

function accumulate(counters, record) {
  counters.samples += 1
  counters.mainHits += record.hits.main
  counters.extraHits += record.hits.extra

  if (record.hits.main < counters.mainDistribution.length) {
    counters.mainDistribution[record.hits.main] += 1
  }
  if (record.hits.extra < counters.extraDistribution.length) {
    counters.extraDistribution[record.hits.extra] += 1
  }

  if (record.ticket.tier) {
    counters.winningIssues += 1
    counters.tierCounts[record.ticket.tier] = (counters.tierCounts[record.ticket.tier] ?? 0) + 1
  }
}

function gameShape(game, kind) {
  const mainMax = Number(game.main_max ?? 0) || 1
  const extraMax = Number(game.extra_max ?? 0) || 1
  const actualMain = Number(game.main_count ?? 0)
  const actualExtra = Number(game.extra_count ?? 0)
  const pickMain = kind === 'ssq' ? 12 : kind === 'kl8' ? 10 : 5
  const pickExtra = kind === 'ssq' ? 4 : kind === 'dlt' ? 2 : 0
  const mainPickRate = pickMain / mainMax
  const extraPickRate = actualExtra > 0 ? pickExtra / extraMax : 0
  return {
    mainMax,
    extraMax,
    actualMain,
    actualExtra,
    pickMain,
    pickExtra,
    mainPickRate,
    extraPickRate,
    expectedMainHits: pickMain * actualMain / mainMax,
    expectedExtraHits: actualExtra > 0 ? (pickExtra * actualExtra) / extraMax : 0,
  }
}

function normalizeCounters(input, game, kind) {
  const shape = gameShape(game, kind)
  const base = createEmptyRecommendationCounters(game, kind)
  if (!input || typeof input !== 'object') {
    return base
  }

  base.samples = toCount(input.samples)
  base.mainHits = toCount(input.mainHits)
  base.extraHits = toCount(input.extraHits)
  base.winningIssues = toCount(input.winningIssues)

  if (input.tierCounts && typeof input.tierCounts === 'object') {
    for (const tier of tierOrder(kind)) {
      const count = toCount(input.tierCounts[tier])
      if (count > 0) {
        base.tierCounts[tier] = count
      }
    }
  }

  for (let hits = 0; hits < shape.actualMain + 1; hits += 1) {
    base.mainDistribution[hits] = toCount(input.mainDistribution?.[hits])
  }
  for (let hits = 0; hits < shape.actualExtra + 1; hits += 1) {
    base.extraDistribution[hits] = toCount(input.extraDistribution?.[hits])
  }

  return base
}

function normalizeRecent(input) {
  if (!Array.isArray(input)) {
    return []
  }
  return input
    .filter(
      (item) =>
        item &&
        typeof item.issue === 'string' &&
        Number.isFinite(Number(item.seq)) &&
        Number.isFinite(Number(item.main)),
    )
    .map((item) => ({
      issue: item.issue,
      seq: Number(item.seq),
      drawDate: item.drawDate ?? null,
      main: toCount(item.main),
      extra: toCount(item.extra),
      total: toCount(item.total),
      tier: typeof item.tier === 'string' ? item.tier : null,
    }))
    .slice(-RECOMMENDATION_TRACK_RECENT_LIMIT)
}

function tierOrder(kind) {
  if (kind === 'dlt') {
    return DLT_TIERS
  }
  if (kind === 'ssq') {
    return SSQ_TIERS
  }
  return KL8_TIERS
}

function combination(n, k) {
  if (k < 0 || k > n) {
    return 0
  }
  let result = 1
  for (let index = 1; index <= k; index += 1) {
    result = (result * (n - k + index)) / index
  }
  return Math.round(result)
}

function clampInt(value, fallback, min, max) {
  const numeric = Math.floor(Number(value))
  if (!Number.isFinite(numeric)) {
    return fallback
  }
  return Math.min(Math.max(numeric, min), max)
}

function toFiniteNumber(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function toCount(value) {
  const numeric = Math.floor(Number(value))
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0
}

function safeRate(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) {
    return 0
  }
  return value / total
}
