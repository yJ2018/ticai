import { apiUrl } from './base'
import { request } from './httpClient'

/** 赛果开奖（读 `match_result`），与「我的投注」的结算共用同一份数据。 */

export type MatchResultItem = {
  matchId: number
  matchNo: string
  /** 销售日（跨零点场次会早于自然日） */
  matchDate: string
  leagueId: number | null
  leagueName: string
  homeName: string
  awayName: string
  homeScore: number | null
  awayScore: number | null
  homeHalfScore: number | null
  awayHalfScore: number | null
  goalLine: number | null
  /** 胜平负 / 让球胜平负：h d a（主队视角） */
  had: 'h' | 'd' | 'a' | null
  hhad: 'h' | 'd' | 'a' | null
  /** 总进球，0–7，7 表示 7+ */
  ttg: number | null
  /** 比分玩法选项 key：s02s01 / s1sh … */
  crs: string | null
  /** 半全场：hh hd … aa */
  hafu: string | null
  settled: boolean
  status: string
  poolStatus: string
  /** 真实开赛时间（关联不到 match 时为空） */
  kickoffAt: string | null
}

type Envelope<T> = { success: boolean; data: T; errorMessage?: string }

export type ResultsQuery = {
  date?: string
  days?: number
  limit?: number
}

export async function getMatchResults(query: ResultsQuery = {}) {
  const params = new URLSearchParams()
  if (query.date) params.set('date', query.date)
  if (query.days) params.set('days', String(query.days))
  if (query.limit) params.set('limit', String(query.limit))

  const suffix = params.toString()
  const response = await request<
    Envelope<{ from: string; to: string; updatedAt: string | null; count: number; items: MatchResultItem[] }>
  >(apiUrl(`/api/results${suffix ? `?${suffix}` : ''}`), { timeoutMs: 20_000 })

  return response.data
}
