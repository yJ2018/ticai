import { apiUrl } from './base'
import { request } from './httpClient'

/** 「我的投注」接口。所有请求都要带 Bearer token。 */

export type MarketPool = 'had' | 'hhad' | 'ttg' | 'crs' | 'hafu'

export type LotteryGameKey = 'pl5' | 'qxc' | 'dlt'

export type LotteryNumbers = { main: number[]; extra: number[] }

export type CreateLotteryBetInput = {
  kind: 'lottery'
  game: LotteryGameKey
  numbers: LotteryNumbers
  multiple: number
  note?: string
}

export type LotteryBetInfo = {
  gameKey: string
  gameNo: string
  name: string
  positional: boolean
  numbers: LotteryNumbers
  tier: string | null
  hits: { main: number; extra: number }
  matchedMain: boolean[]
  draw: {
    issue: string
    drawDate: string
    main: number[]
    extra: number[]
  } | null
}

export type BetLegInput = {
  sportteryMatchId: number
  matchNumStr?: string
  leagueName?: string
  homeName?: string
  awayName?: string
  kickoffAt?: string | null
  pool: MarketPool
  optionKey: string
  optionLabel?: string
  odds: number
  goalLine?: number | null
}

export type CreateBetInput = {
  title?: string
  passTypes: string[]
  multiple: number
  legs: BetLegInput[]
  note?: string
}

export type BetLegResult = {
  settled: boolean
  homeScore: number | null
  awayScore: number | null
  homeHalfScore: number | null
  awayHalfScore: number | null
}

export type BetLeg = BetLegInput & {
  id: string
  matchNo: string
  leagueName: string
  homeName: string
  awayName: string
  kickoffAt: string | null
  optionLabel: string
  outcome: 'won' | 'lost' | 'pending'
  result: BetLegResult | null
}

export type BetPassTypeDetail = {
  passType: string
  need: number
  totalUnits: number
  wonUnits: number
  payout: number
}

export type Bet = {
  id: string
  kind: 'football' | 'lottery'
  title: string
  passTypes: string[]
  multiple: number
  units: number
  amount: number
  maxBonus: number
  note: string | null
  placedAt: string
  matchCount: number
  status: 'pending' | 'won' | 'lost'
  payout: number
  passTypeDetails: BetPassTypeDetail[]
  legs: BetLeg[]
  /** kind === 'lottery' 时存在 */
  lottery?: LotteryBetInfo
}

export type BetStats = {
  total: number
  pending: number
  won: number
  lost: number
  amount: number
  payout: number
}

type Envelope<T> = { success: boolean; data: T; errorMessage?: string }

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` }
}

export async function listBets(
  token: string,
  params: { limit?: number; offset?: number; pool?: MarketPool | '' } = {},
): Promise<{ items: Bet[]; stats: BetStats | null }> {
  const query = new URLSearchParams()
  if (params.limit) query.set('limit', String(params.limit))
  if (params.offset) query.set('offset', String(params.offset))
  if (params.pool) query.set('pool', params.pool)

  const suffix = query.toString()
  const response = await request<Envelope<{ items: Bet[]; stats: BetStats | null }>>(
    apiUrl(`/api/bets${suffix ? `?${suffix}` : ''}`),
    { headers: authHeaders(token) },
  )
  return response.data
}

export async function createBet(token: string, input: CreateBetInput): Promise<Bet> {
  const response = await request<Envelope<Bet>>(apiUrl('/api/bets'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(input),
  })
  return response.data
}

/** 彩票选号投注：号码与倍数由服务端再校验一遍。 */
export async function createLotteryBet(token: string, input: CreateLotteryBetInput): Promise<Bet> {
  const response = await request<Envelope<Bet>>(apiUrl('/api/bets'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(input),
  })
  return response.data
}

export async function deleteBet(token: string, betId: string): Promise<void> {
  await request<Envelope<{ ok: boolean }>>(apiUrl(`/api/bets/${encodeURIComponent(betId)}`), {
    method: 'DELETE',
    headers: authHeaders(token),
  })
}
