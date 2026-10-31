import { apiUrl } from './base'
import { request } from './httpClient'

/** 「我的投注」接口。所有请求都要带 Bearer token。 */

export type MarketPool = 'had' | 'hhad' | 'ttg' | 'crs' | 'hafu'

export type LotteryGameKey = 'pl5' | 'qxc' | 'dlt'

export type LotteryNumbers = {
  /** 位次型：number[][]（每位可多选）；大乐透：number[]（前区池） */
  main: number[] | number[][]
  extra: number[]
}

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
  mode: 'single' | 'multiple'
  numbers: LotteryNumbers
  tier: string | null
  tiers: Array<{ tier: string; units: number }>
  winningUnits: number
  hits: { main: number; extra: number }
  matchedMain: boolean[]
  matchedExtra: boolean[]
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
  /** 开奖赔率：停售前最后一份官方赔率（没有快照的场次为 null） */
  closingOdds: number | null
  /** 开奖赔率对应的快照时间 */
  closingOddsAt: string | null
  result: BetLegResult | null
}

/**
 * 按开奖赔率试算的奖金对比。
 *
 * 竞彩按票面固定奖金结算，`payout` 是票面口径；这里只是用开奖赔率（停售前最后一份
 * 官方赔率）按同一套规则再算一遍，看赔率变化对奖金的影响。还没开完奖、或命中组合
 * 缺开奖赔率时不给数字（null），避免算出一个偏小/偏大的假数。
 */
export type BetClosing = {
  payout: number | null
  diff: number | null
  complete: boolean
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
  /** kind === 'football' 时给出；彩票单为 null */
  closing: BetClosing | null
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
