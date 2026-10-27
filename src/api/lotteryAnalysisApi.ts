import { apiUrl } from './base'
import { request } from './httpClient'
import { type DltRecommendation } from '../domain/dltRecommendation'
import {
  type HistoryPredictionAnalysis,
  type MathTrendPredictionAnalysis,
} from '../domain/historyPrediction'

/**
 * 开奖分析快照（服务端预算）。
 *
 * 分析要在全量开奖上跑（排列五 7761 期），前端不再「下载全量 → Worker 里算」：
 * 爬虫抓到新开奖后就把结果算好存进 `lottery_analysis_snapshot`，
 * 这里只取最新一条，并把溯源（基于哪一期 / 哪一天 / 多少期样本）一起带回来。
 */

export type LotteryAnalysisKind = 'prediction' | 'math_trend' | 'dlt'

export type LotteryAnalysisSample = {
  throughIssue: string
  throughIssueSeq: number
  throughDrawDate: string
  fromIssue: string | null
  fromIssueSeq: number | null
  fromDrawDate: string | null
  drawCount: number
}

export type LotteryAnalysisGame = {
  gameKey: string
  gameNo: string
  name: string
  positional: boolean
  mainCount: number | null
}

export type LotteryAnalysisEngine = {
  version: string
  digest: string
  runtime: string
}

export type LotteryAnalysisSnapshot<T> = {
  game: LotteryAnalysisGame
  kind: LotteryAnalysisKind
  configKey: string
  sample: LotteryAnalysisSample
  engine: LotteryAnalysisEngine
  analysis: T
  computedAt: string | null
  source: 'crawler' | 'cli' | 'api'
  durationMs: number | null
  /** true = 快照缺失，这次请求现场算了一次并落库 */
  triggered: boolean
  /** true = 库里最后一期开奖已经领先这份快照 */
  stale: boolean
  latestDraw: { issue: string; issueSeq: number; drawDate: string } | null
}

type ApiEnvelope<T> = {
  success: boolean
  data?: T
  errorMessage?: string
}

export type AnalysisSnapshotKindMap = {
  prediction: HistoryPredictionAnalysis
  math_trend: MathTrendPredictionAnalysis
  dlt: DltRecommendation
}

export type AnalysisRequestParams = {
  /** pl5 / qxc / dlt，也接受体彩 gameNo */
  game: string
  kind?: LotteryAnalysisKind
  /** 马尔可夫阶数 1–5（只有 prediction 生效，服务端已预算好 5 档） */
  order?: number
}

export async function getLotteryAnalysis<K extends LotteryAnalysisKind>(
  params: AnalysisRequestParams & { kind: K },
  options: { signal?: AbortSignal } = {},
): Promise<LotteryAnalysisSnapshot<AnalysisSnapshotKindMap[K]>> {
  const query = new URLSearchParams({ game: params.game, kind: params.kind })
  if (params.order) {
    query.set('order', String(params.order))
  }

  const body = await request<ApiEnvelope<LotteryAnalysisSnapshot<AnalysisSnapshotKindMap[K]>>>(
    apiUrl(`/api/analysis/lottery?${query.toString()}`),
    { signal: options.signal },
  )

  if (!body.success || !body.data) {
    throw new Error(body.errorMessage || '分析接口返回失败')
  }

  return body.data
}

/** 巡检页 / 调试用：每个彩种每种分析的最新快照与是否落后开奖 */
export type LotteryAnalysisVersion = {
  gameKey: string
  gameName: string
  kind: LotteryAnalysisKind
  configKey: string
  throughIssue: string
  throughDrawDate: string
  drawCount: number
  source: string
  durationMs: number | null
  computedAt: string | null
  latestIssue: string | null
  stale: boolean
}

export async function getLotteryAnalysisVersions(): Promise<LotteryAnalysisVersion[]> {
  const body = await request<ApiEnvelope<{ games: Array<{ items: LotteryAnalysisVersion[] }> }>>(
    apiUrl('/api/analysis/lottery/snapshots'),
  )
  if (!body.success || !body.data) {
    throw new Error(body.errorMessage || '分析巡检接口返回失败')
  }
  return body.data.games.flatMap((group) => group.items)
}
