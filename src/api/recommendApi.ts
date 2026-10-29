import { apiUrl } from './base'
import { request } from './httpClient'

/**
 * 服务端推荐（/api/recommendations）。
 *
 * 概率与方案都在服务端算：赔率去水 → 有界的数据修正（近况 / 伤停）→ 串关风控。
 * 前端只负责展示与「应用到投注单」，不参与任何概率计算。
 */

export type RecommendPool = 'had' | 'hhad' | 'ttg' | 'crs' | 'hafu' | 'mixed'
export type RecommendScope = 'today' | 'all'

export type RecommendLeg = {
  matchId: number
  matchNo: string
  league: string
  teams: string
  kickoffAt: string | null
  /** 这条腿属于哪个玩法（mixed 时每条腿可能不同） */
  pool: 'had' | 'hhad' | 'ttg'
  poolLabel: string
  /** 投注单识别的选项键：h/d/a、rq-h、s3 … */
  optionKey: string
  optionLabel: string
  odd: number
  /** 去水后的市场概率 */
  marketP: number
  /** 模型概率（市场 λ + 近况/伤停修正） */
  modelP: number
  /** 融合概率 = w·模型 + (1-w)·市场 */
  blendP: number
  /** 融合概率下的期望：blendP × odd − 1 */
  edge: number
  /** 模型权重（0.02–0.42，样本越多越大） */
  weight: number
  confidence: 'high' | 'medium' | 'low'
  reasons: string[]
  sample: {
    homeMatches: number
    awayMatches: number
    injuriesHome: number
    injuriesAway: number
  }
}

export type RecommendPlan = {
  id: 'single' | 'safe' | 'aggressive'
  label: string
  risk: '低' | '中' | '高'
  legs: RecommendLeg[]
  totalOdd: number
  hitProb: number
  expectedReturn: number
  note: string
}

export type RecommendCandidate = {
  matchId: number
  matchNo: string
  league: string
  teams: string
  kickoffAt: string | null
  pool: 'had' | 'hhad' | 'ttg'
  optionKey: string
  optionLabel: string
  odd: number
  marketP: number
  modelP: number
  blendP: number
  edge: number
  weight: number
  confidence: 'high' | 'medium' | 'low'
  passSafe: boolean
  passAggressive: boolean
  rejectReason: string
  reasons: string[]
}

export type BacktestBlock = {
  n: number
  hits: number
  hitRate: number
  roi: number
  avgOdd: number
}

export type BacktestSummary = {
  window: { from: string | null; to: string | null; matches: number }
  singles: BacktestBlock
  wideSingles: BacktestBlock
  doubles: BacktestBlock
  longshot: BacktestBlock
  bands: Array<BacktestBlock & { label: string }>
  note: string
}

export type RecommendResponse = {
  generatedAt: string
  scope: RecommendScope
  pool: RecommendPool
  poolLabel: string
  coverage: {
    onSale: number
    inScope: number
    withOdds: number
    withInjury: number
    withHistory: number
    historyMatches: number
    today: string
  }
  filtered: {
    noOdds: number
    noMarket: number
    noCandidate: number
    probTooLow: number
    oddsOutOfBand: number
    invalidPool: boolean
  }
  plans: RecommendPlan[]
  candidates: RecommendCandidate[]
  analyzed: number
  notes: string[]
  backtest: BacktestSummary
  cache?: 'hit' | 'miss'
}

export async function fetchRecommendations(
  pool: RecommendPool,
  scope: RecommendScope,
  signal?: AbortSignal,
): Promise<RecommendResponse> {
  const query = new URLSearchParams({ pool, scope })
  const response = await request<{ success: boolean; data: RecommendResponse }>(
    apiUrl(`/api/recommendations?${query.toString()}`),
    { signal, timeoutMs: 20_000 },
  )
  return response.data
}
