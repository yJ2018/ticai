import { DEFAULT_PREDICTION_SCORE_WEIGHTS } from './history-prediction.mjs'

/**
 * 分析快照的「配置指纹」与预设组合。
 *
 * 为什么要 config_key：
 *   同一期开奖、不同参数（马尔可夫阶数、窗口、权重）算出来的是不同的分析结果，
 *   各自要能独立存一条、独立取最新。config_key 就是这张表的参数维度。
 *
 * 为什么要预设：
 *   分析页的马尔可夫阶数是 1–5 的下拉，用户切换时不该等一次 1.5s 的服务端计算；
 *   开奖后一次性把 5 个阶数都算好存下来，前端切档就是换一个 URL。
 *   权重滑块是连续值，暂不进预设——需要时按请求参数现算一条，同样会落库。
 */

export const ENGINE_VERSION = 'snapshot-1'
export const KINDS = ['prediction', 'math_trend', 'dlt']
export const PREDICTION_MARKOV_ORDERS = [1, 2, 3, 4, 5]
export const PREDICTION_DEFAULT_ORDER = 2

/** 与 domain/historyPrediction.ts 的 resolveMathTrendConfig 默认值保持一致 */
export const MATH_TREND_DEFAULTS = {
  sampleWindow: 240,
  trendWindow: 36,
  validationStart: 120,
  candidateCount: 3,
}

/** 与 domain/dltRecommendation.ts 的 LONG_WINDOW 保持一致 */
export const DLT_WINDOW = 300

export function defaultKindForGame(game) {
  return game.is_positional ? 'prediction' : 'dlt'
}

function clampInt(value, fallback, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }
  return Math.min(Math.max(Math.floor(numeric), min), max)
}

function weightsPercent(weights) {
  return ['recent', 'long', 'omission', 'transition', 'pairTransition'].map((key) =>
    Number((Number(weights[key] ?? 0) * 100).toFixed(2)),
  )
}

function isDefaultWeights(weights) {
  const current = weightsPercent(weights)
  const base = weightsPercent(DEFAULT_PREDICTION_SCORE_WEIGHTS)
  return current.every((value, index) => value === base[index])
}

export function predictionConfigKey(options = {}) {
  const order = clampInt(options.markovOrder, PREDICTION_DEFAULT_ORDER, 1, 5)
  const weights = { ...DEFAULT_PREDICTION_SCORE_WEIGHTS, ...(options.scoreWeights ?? {}) }
  const base = `markov=${order}`
  // 默认权重不写进 key：绝大多数请求都是默认值，key 越短越好读
  return isDefaultWeights(weights) ? base : `${base};w=${weightsPercent(weights).join('-')}`
}

export function parsePredictionConfigKey(configKey) {
  const orderMatch = /markov=(\d+)/.exec(String(configKey))
  const weightsMatch = /w=([\d.\-]+)/.exec(String(configKey))
  const options = {
    markovOrder: clampInt(orderMatch?.[1], PREDICTION_DEFAULT_ORDER, 1, 5),
  }
  if (weightsMatch) {
    const values = weightsMatch[1].split('-').map(Number)
    if (values.length === 5 && values.every((value) => Number.isFinite(value))) {
      options.scoreWeights = {
        recent: values[0] / 100,
        long: values[1] / 100,
        omission: values[2] / 100,
        transition: values[3] / 100,
        pairTransition: values[4] / 100,
      }
    }
  }
  return options
}

export function mathTrendConfigKey(options = {}) {
  const config = {
    window: clampInt(options.sampleWindow, MATH_TREND_DEFAULTS.sampleWindow, 80, 400),
    trend: clampInt(options.trendWindow, MATH_TREND_DEFAULTS.trendWindow, 12, 90),
    validate: clampInt(options.validationStart, MATH_TREND_DEFAULTS.validationStart, 40, 240),
    candidates: clampInt(options.candidateCount, MATH_TREND_DEFAULTS.candidateCount, 1, 5),
  }
  return `window=${config.window};trend=${config.trend};validate=${config.validate};candidates=${config.candidates}`
}

export function parseMathTrendConfigKey(configKey) {
  const read = (name, fallback) => {
    const hit = new RegExp(`${name}=(\\d+)`).exec(String(configKey))
    return hit ? Number(hit[1]) : fallback
  }
  return {
    sampleWindow: read('window', MATH_TREND_DEFAULTS.sampleWindow),
    trendWindow: read('trend', MATH_TREND_DEFAULTS.trendWindow),
    validationStart: read('validate', MATH_TREND_DEFAULTS.validationStart),
    candidateCount: read('candidates', MATH_TREND_DEFAULTS.candidateCount),
  }
}

export function dltConfigKey() {
  return `window=${DLT_WINDOW}`
}

/** 参数 → 算法选项；positionCount 跟着彩种走（排列五 5、七星彩 7） */
export function analysisOptions(kind, game, configKey) {
  if (kind === 'prediction') {
    return { ...parsePredictionConfigKey(configKey), positionCount: game.main_count ?? 5 }
  }
  if (kind === 'math_trend') {
    return parseMathTrendConfigKey(configKey)
  }
  return {}
}

/**
 * 开奖后一次要算的组合：
 *   位置型（排列三/五、七星彩）：5 个马尔可夫阶数 + 数学走势；
 *   大乐透：5+2 推演。
 * 单次成本实测（7760 期）约 1.5s/档，开奖一天一期，可以接受。
 */
export function presetsForGame(game) {
  if (game.game_key === 'dlt' || !game.is_positional) {
    return game.game_key === 'dlt'
      ? [{ kind: 'dlt', configKey: dltConfigKey(), options: {} }]
      : []
  }

  return [
    ...PREDICTION_MARKOV_ORDERS.map((order) => ({
      kind: 'prediction',
      configKey: predictionConfigKey({ markovOrder: order }),
      options: { markovOrder: order },
    })),
    {
      kind: 'math_trend',
      configKey: mathTrendConfigKey(),
      options: {},
    },
  ]
}
