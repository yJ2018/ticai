/** 彩种标识：首版仅排列五，保留联合类型便于扩展 */
export type LotteryHistoryGameType = 'pl5'

/** 单期开奖记录（已归一化为展示字段） */
export type LotteryHistoryEntry = {
  issue: string
  drawDate: string
  numbers: string[]
  salesAmount: string
  poolAmount: string
  firstPrizeCount: string
  firstPrizeAmount: string
}

/** 分页结果 */
export type LotteryHistoryPageResult = {
  list: LotteryHistoryEntry[]
  pageNo: number
  pageSize: number
  total: number
  pages: number
}

/** 缓存元数据（可持久化，不含条目数组） */
export type LotteryHistoryCacheMeta = {
  version: number
  gameType: LotteryHistoryGameType
  total: number
  archivePageSize: number
  archivePages: number
  loadedArchivePages: number[]
  fullySynced: boolean
  newestIssue: string
  lastUpdatedAt: number
  lastIncrementalSyncAt: number
}

/** 内存中的完整缓存 */
export type LotteryHistoryCache = LotteryHistoryCacheMeta & {
  items: LotteryHistoryEntry[]
}
