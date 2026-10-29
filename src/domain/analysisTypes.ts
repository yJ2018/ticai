import { type DltBackIndicators, type DltFrontIndicators } from './dltIndicators'

/**
 * 分析结果的**类型与默认值**（只保留形状，不含任何算法实现）。
 *
 * 预测 / 走势 / 大乐透推演的真实计算已经全部搬到 Python 分析服务
 * （apps/analysis），前端只负责渲染快照。这里留着类型是为了：
 *   - 快照接口的返回类型（`AnalysisSnapshotKindMap`）；
 *   - 首屏还没有快照时的空态占位（`EMPTY_PREDICTION_ANALYSIS` 等）；
 *   - 权重滑块的取值范围（`PredictionScoreWeights` 与默认值）。
 *
 * 原 `domain/historyPrediction.ts`、`domain/dltRecommendation.ts` 的算法实现已删除，
 * 服务端对应实现见 `apps/analysis/app/analysis/`。
 */

export type PredictionScoreWeights = {
  recent: number
  long: number
  omission: number
  transition: number
  pairTransition: number
}

export const DEFAULT_PREDICTION_SCORE_WEIGHTS: PredictionScoreWeights = {
  recent: 0.34,
  long: 0.2,
  omission: 0.22,
  transition: 0.14,
  pairTransition: 0.1,
}

export type PredictionHistoryEntry = {
  issue?: string
  numbers: string[]
}

export type PredictionScoreBreakdown = {
  recent: number
  long: number
  omission: number
  transition: number
  pairTransition: number
}

export type PredictionRankedDigit = {
  digit: number
  score: number
  totalCount: number
  recentCount: number
  missSpan: number
  transitionCount: number
  pairTransitionCount: number
  breakdown: PredictionScoreBreakdown
}

export type PredictionBacktest = {
  samples: number
  top1Hits: number
  top3Hits: number
  top1Rate: number
  top3Rate: number
}

export type PredictionMarkovCandidate = {
  digit: number
  probability: number
  count: number
}

export type PredictionMarkovPositionAnalysis = {
  order: number
  effectiveOrder: number
  sourcePattern: number[]
  supportCount: number
  picks: number[]
  candidates: PredictionMarkovCandidate[]
  backtest: PredictionBacktest
}

export type PredictionPositionAnalysis = {
  position: number
  picks: number[]
  candidates: PredictionRankedDigit[]
  latestDigit: number | null
  historySample: number
  recentDigits: number[]
  backtest: PredictionBacktest
  markov: PredictionMarkovPositionAnalysis
}

export type PredictionNumberCandidate = {
  value: string
  score: number
}

export type PredictionDigitStat = {
  digit: number
  recentCount: number
  longCount: number
  missSpan: number
}

export type PredictionDistributionBucket = {
  label: string
  count: number
  rate: number
}

export type PredictionHotColdStats = {
  recentWindow: number
  longWindow: number
  hotDigits: PredictionDigitStat[]
  coldDigits: PredictionDigitStat[]
}

export type PredictionSumSpanStats = {
  recentAverageSum: number
  recentAverageSpan: number
  topSums: PredictionDistributionBucket[]
  topSpans: PredictionDistributionBucket[]
}

export type PredictionParitySizeStats = {
  oddRate: number
  evenRate: number
  bigRate: number
  smallRate: number
  oddEvenPatterns: PredictionDistributionBucket[]
  bigSmallPatterns: PredictionDistributionBucket[]
}

export type PredictionStatistics = {
  hotCold: PredictionHotColdStats
  sumSpan: PredictionSumSpanStats
  paritySize: PredictionParitySizeStats
}

export type PredictionConfig = {
  recentWindow: number
  longWindow: number
  minTrainingSize: number
  combinationPoolSize: number
  combinationLimit: number
  markovOrder: number
  scoreWeights: PredictionScoreWeights
}

export type PredictionMarkovAnalysis = {
  order: number
  averageTop1Rate: number
  averageTop3Rate: number
  combinations: PredictionNumberCandidate[]
}

export type HistoryPredictionAnalysis = {
  sampleSize: number
  averageTop1Rate: number
  averageTop3Rate: number
  positions: PredictionPositionAnalysis[]
  combinations: PredictionNumberCandidate[]
  markov: PredictionMarkovAnalysis
  config: PredictionConfig
  statistics: PredictionStatistics
}

export type MathTrendScoreBreakdown = {
  distribution: number
  trend: number
  cycle: number
  momentum: number
}

export type MathTrendRankedDigit = {
  digit: number
  score: number
  occurrenceRate: number
  recentMomentum: number
  averageGap: number
  currentGap: number
  predictedDistance: number
  distributionGap: number
  breakdown: MathTrendScoreBreakdown
}

export type MathTrendPositionAnalysis = {
  position: number
  picks: number[]
  candidates: MathTrendRankedDigit[]
  latestDigit: number | null
  historySample: number
  sampleWindow: number
  recentDigits: number[]
  backtest: PredictionBacktest
  predictedCenter: number | null
  trendSlope: number
  recentAverage: number
  volatility: number
}

export type MathTrendConfig = {
  sampleWindow: number
  trendWindow: number
  validationStart: number
  candidateCount: number
}

export type MathTrendPredictionAnalysis = {
  sampleSize: number
  effectiveSampleWindow: number
  validationStart: number
  averageTop1Rate: number
  averageTop3Rate: number
  positions: MathTrendPositionAnalysis[]
  config: MathTrendConfig
}

export type DltRecommendationEntry = {
  numbers: string[]
}

export type DltRecommendationWindows = {
  short: number
  recent: number
  long: number
}

export type DltRecommendationTargets = {
  averageSum: number
  averageSpan: number
  averageOdd: number
  averageBig: number
  averageZones: [number, number, number]
  commonOddEven: string
  commonBigSmall: string
  commonZones: string
  averageBackSum: number
  averageBackSpan: number
  averageBackOdd: number
}

export type DltRecommendation = {
  windows: DltRecommendationWindows
  picks: {
    front: number[]
    back: number[]
  }
  alternates: {
    front: number[]
    back: number[]
  }
  metrics: {
    front: DltFrontIndicators
    back: DltBackIndicators
  }
  targets: DltRecommendationTargets
  reasons: string[]
}

const EMPTY_BACKTEST: PredictionBacktest = { samples: 0, top1Hits: 0, top3Hits: 0, top1Rate: 0, top3Rate: 0 }

function emptyPredictionPosition(position: number, markovOrder: number): PredictionPositionAnalysis {
  return {
    position,
    picks: [],
    candidates: [],
    latestDigit: null,
    historySample: 0,
    recentDigits: [],
    backtest: { ...EMPTY_BACKTEST },
    markov: {
      order: markovOrder,
      effectiveOrder: 0,
      sourcePattern: [],
      supportCount: 0,
      picks: [],
      candidates: [],
      backtest: { ...EMPTY_BACKTEST },
    },
  }
}

/** 首屏还没拿到快照时的占位：形状完整、数字全是 0，渲染层不用到处判空。 */
export function createEmptyPredictionAnalysis(markovOrder = 2): HistoryPredictionAnalysis {
  return {
    sampleSize: 0,
    averageTop1Rate: 0,
    averageTop3Rate: 0,
    positions: Array.from({ length: 5 }, (_, position) => emptyPredictionPosition(position, markovOrder)),
    combinations: [],
    markov: { order: markovOrder, averageTop1Rate: 0, averageTop3Rate: 0, combinations: [] },
    config: {
      recentWindow: 12,
      longWindow: 60,
      minTrainingSize: 30,
      combinationPoolSize: 3,
      combinationLimit: 6,
      markovOrder,
      scoreWeights: { ...DEFAULT_PREDICTION_SCORE_WEIGHTS },
    },
    statistics: {
      hotCold: { recentWindow: 12, longWindow: 60, hotDigits: [], coldDigits: [] },
      sumSpan: { recentAverageSum: 0, recentAverageSpan: 0, topSums: [], topSpans: [] },
      paritySize: {
        oddRate: 0,
        evenRate: 0,
        bigRate: 0,
        smallRate: 0,
        oddEvenPatterns: [],
        bigSmallPatterns: [],
      },
    },
  }
}

export const EMPTY_PREDICTION_ANALYSIS: HistoryPredictionAnalysis = createEmptyPredictionAnalysis()

function emptyMathTrendPosition(position: number): MathTrendPositionAnalysis {
  return {
    position,
    picks: [],
    candidates: [],
    latestDigit: null,
    historySample: 0,
    sampleWindow: 0,
    recentDigits: [],
    backtest: { ...EMPTY_BACKTEST },
    predictedCenter: null,
    trendSlope: 0,
    recentAverage: 0,
    volatility: 0,
  }
}

export function createEmptyMathTrendAnalysis(): MathTrendPredictionAnalysis {
  return {
    sampleSize: 0,
    effectiveSampleWindow: 0,
    validationStart: 120,
    averageTop1Rate: 0,
    averageTop3Rate: 0,
    positions: Array.from({ length: 5 }, (_, position) => emptyMathTrendPosition(position)),
    config: { sampleWindow: 240, trendWindow: 36, validationStart: 120, candidateCount: 3 },
  }
}

export const EMPTY_MATH_TREND_ANALYSIS: MathTrendPredictionAnalysis = createEmptyMathTrendAnalysis()

/** 滑块用的 0–100 整数百分比（对应服务端 `w=34-20-22-14-10`） */
export function predictionWeightsToPercent(weights: PredictionScoreWeights): number[] {
  return [
    Number((weights.recent * 100).toFixed(2)),
    Number((weights.long * 100).toFixed(2)),
    Number((weights.omission * 100).toFixed(2)),
    Number((weights.transition * 100).toFixed(2)),
    Number((weights.pairTransition * 100).toFixed(2)),
  ]
}
