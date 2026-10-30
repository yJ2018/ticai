import { apiUrl } from './base'
import { request } from './httpClient'

/** 开奖记录 × 总进球赔率分布（服务端聚合，前端只渲染）。 */

export type TtgSeriesKey = 'lowest' | 'second' | 'third' | 'winning'

export type TtgSeries = {
  key: TtgSeriesKey
  label: string
  average: number | null
  median: number | null
  min: number | null
  max: number | null
}

export type TtgBin = {
  /** 区间下界（含） */
  from: number
  /** 区间上界（不含）；最后一档为 null（30+） */
  to: number | null
  label: string
  lowest: number
  second: number
  third: number
  winning: number
}

export type TtgRank = {
  rank: number
  label: string
  count: number
  /** 0–1 */
  rate: number
}

export type TtgHighlights = {
  lowestHits: number
  lowestHitRate: number
  top3Hits: number
  top3HitRate: number
  averageLowest: number | null
  averageWinning: number | null
  averageRatio: number | null
}

export type TtgRecentSample = {
  matchId: number
  matchDate: string
  leagueName: string
  homeName: string
  awayName: string
  homeScore: number | null
  awayScore: number | null
  score: string | null
  ttg: number
  ttgLabel: string
  lowest: number | null
  second: number | null
  third: number | null
  winning: number | null
  rank: number
  rankLabel: string
  oddsCapturedAt: string | null
}

export type TtgSampleMeta = {
  matches: number
  settledResults: number
  /** 有赔率的场次 / 有总进球赛果的场次，0–1 */
  coverage: number
  skipped: number
  from: string | null
  to: string | null
  updatedAt: string | null
}

export type OddsDistribution = {
  sample: TtgSampleMeta
  bins: TtgBin[]
  series: TtgSeries[]
  ranks: TtgRank[]
  highlights: TtgHighlights
  recent: TtgRecentSample[]
  cache?: 'hit' | 'miss'
}

type Envelope<T> = { success: boolean; data: T; errorMessage?: string }

export async function getOddsDistribution(signal?: AbortSignal) {
  const response = await request<Envelope<OddsDistribution>>(apiUrl('/api/odds-distribution'), {
    timeoutMs: 20_000,
    signal,
  })
  return response.data
}
