import { apiUrl } from './base'
import { streamSseJson, type AnalysisDone, type AnalysisHandlers } from './analysisApi'

/**
 * 串关 AI 分析：只提交「选了哪几场、哪些选项」。
 *
 * 赔率、联赛、伤停由服务端按 matchId 从库里补；提示词不再打进前端 bundle。
 */

export type ParlayLegInput = {
  matchId: number
  matchNo?: string
  teams?: string
  kickoffTime?: string
  options: Array<{ label: string; value: string }>
  /** 3 小时内的单场分析，服务端会复用而不是重复分析 */
  cachedAnalysis?: string
}

export type ParlayRequest = {
  pool: string
  passSummaryText: string
  betAmount: number
  maxBonus: number
  entries: ParlayLegInput[]
  thinking?: boolean
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  timeoutMs?: number
}

export async function askParlayAnalysis(
  request: ParlayRequest,
  handlers: AnalysisHandlers = {},
): Promise<AnalysisDone> {
  const { signal, timeoutMs, ...body } = request

  return streamSseJson(
    apiUrl('/api/ai-parlay'),
    body as unknown as Record<string, unknown>,
    handlers,
    { signal, timeoutMs, timeoutMessage: '串关分析超时，请重试' },
  )
}
