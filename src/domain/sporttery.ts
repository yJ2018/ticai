export type SportteryEnvelope<T> = {
  success: boolean
  errorCode: string
  errorMessage: string
  value: T
}

/** 竞彩玩法池；`mixed` 表示不指定 poolCode（返回全部玩法） */
export type MatchPoolKey = 'had' | 'crs' | 'ttg' | 'hafu' | 'mixed'

export type LotteryHistoryParams = {
  gameNo: string
  provinceId?: number
  pageSize?: number
  isVerify?: number
  termLimits?: number
  pageNo?: number
}

export type LotteryPrizeLevelItem = {
  prizeLevel?: string
  prizeLevelName?: string
  stakeCount?: number | string
  prizeAmount?: number | string
  totalAmount?: number | string
  [key: string]: unknown
}

export type LotteryHistoryItem = {
  lotteryDrawNum?: string
  lotteryDrawResult?: string
  lotteryUnsortDrawresult?: string
  lotteryDrawTime?: string
  lotterySaleEndtime?: string
  lotterySaleAmount?: number | string
  poolAmount?: number | string
  prizeLevelList?: LotteryPrizeLevelItem[]
  [key: string]: unknown
}

export type LotteryHistoryValue = {
  list: LotteryHistoryItem[]
  pageNo?: number
  pageSize?: number
  pages?: number
  total?: number
  [key: string]: unknown
}

export type TtgOdds = {
  s0?: string
  s1?: string
  s2?: string
  s3?: string
  s4?: string
  s5?: string
  s6?: string
  s7?: string
  updateDate?: string
  updateTime?: string
  [key: string]: unknown
}

export type CrsOdds = {
  s00s00?: string
  s01s00?: string
  s02s00?: string
  s02s01?: string
  s03s01?: string
  s1sh?: string
  s1sd?: string
  s1sa?: string
  updateDate?: string
  updateTime?: string
  [key: string]: unknown
}

export type HadOdds = {
  h?: string
  d?: string
  a?: string
  goalLine?: string
  goalLineValue?: string
  updateDate?: string
  updateTime?: string
  [key: string]: unknown
}

export type HafuOdds = {
  hh?: string
  hd?: string
  ha?: string
  dh?: string
  dd?: string
  da?: string
  ah?: string
  ad?: string
  aa?: string
  goalLine?: string
  goalLineValue?: string
  updateDate?: string
  updateTime?: string
  [key: string]: unknown
}

export type MatchItem = {
  matchId: number
  matchNumStr?: string
  leagueAllName?: string
  homeTeamAbbName?: string
  awayTeamAbbName?: string
  matchTime?: string
  ttg?: TtgOdds
  crs?: CrsOdds
  had?: HadOdds
  hhad?: HadOdds
  hafu?: HafuOdds
  [key: string]: unknown
}

export type MatchCalculatorValue = {
  matchInfoList: Array<{
    businessDate: string
    subMatchList: MatchItem[]
  }>
  [key: string]: unknown
}
