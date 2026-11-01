import { apiUrl } from './base'
import { request } from './httpClient'

/** 赛果开奖（读 `match_result`），与「我的投注」的结算共用同一份数据。 */

export type MatchResultItem = {
  matchId: number
  matchNo: string
  /** 开赛日（跨零点场次会晚于期） */
  matchDate: string
  /** 期（销售日）：竞彩按「周X」分期，跨零点场次归前一天 */
  period: string
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

/** 一期（销售日）的汇总，赛果页用它做「按期翻页」 */
export type ResultPeriod = {
  period: string
  /** 周一 / 周六 … */
  label: string
  count: number
  settled: number
}

export type ResultsPayload = {
  period: string
  label: string
  count: number
  settled: number
  updatedAt: string | null
  /** 最近若干期，按时间倒序，前端直接渲染成切换条 */
  periods: ResultPeriod[]
  items: MatchResultItem[]
}

type Envelope<T> = { success: boolean; data: T; errorMessage?: string }

export type ResultsQuery = {
  /** 期（销售日）'YYYY-MM-DD'；不传 = 最近一期 */
  period?: string
  limit?: number
}

export async function getMatchResults(query: ResultsQuery = {}) {
  const params = new URLSearchParams()
  if (query.period) params.set('period', query.period)
  if (query.limit) params.set('limit', String(query.limit))

  const suffix = params.toString()
  const response = await request<Envelope<ResultsPayload>>(
    apiUrl(`/api/results${suffix ? `?${suffix}` : ''}`),
    { timeoutMs: 20_000 },
  )

  return response.data
}
