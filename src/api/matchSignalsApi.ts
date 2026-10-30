import { apiUrl } from './base'
import { request } from './httpClient'

/**
 * 投注页「赔率接近」标注（/api/match-signals）。
 *
 * 服务端用推荐引擎的同一套模型（市场概率 + 双方近期战绩 + 伤停）比较最低两档，
 * 前端只拿结果画在选项上，不参与任何概率计算。
 */

export type SignalPool = 'had' | 'hhad' | 'ttg' | 'mixed'

export type MatchSignalOption = {
  optionKey: string
  optionLabel: string
  odd: number
  marketP: number
  modelP: number
  blendP: number
  /** 模型更偏向这个选项 */
  preferred: boolean
}

export type MatchSignal = {
  matchId: number
  matchNo: string
  teams: string
  pool: 'had' | 'hhad' | 'ttg'
  poolLabel: string
  /** 最低两档的相对差，0.031 = 3.1% */
  gap: number
  note: string
  options: MatchSignalOption[]
  sample: {
    homeMatches: number
    awayMatches: number
  }
  goalExpectation?: {
    expectedTotal: number | null
    marketTotal: number | null
    homeMatches: number
    awayMatches: number
  }
}

export type MatchSignalsResponse = {
  generatedAt: string
  scope: 'all'
  pool: SignalPool
  poolLabel: string
  signals: MatchSignal[]
  cache?: 'hit' | 'miss'
}

export async function fetchMatchSignals(pool: SignalPool, signal?: AbortSignal) {
  const query = new URLSearchParams({ pool })
  const response = await request<{ success: boolean; data: MatchSignalsResponse }>(
    apiUrl(`/api/match-signals?${query.toString()}`),
    { signal, timeoutMs: 20_000 },
  )
  return response.data
}
