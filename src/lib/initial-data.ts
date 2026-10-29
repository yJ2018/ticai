import type { MatchResultItem } from '../api/resultsApi'
import type { MatchCard, MatchPoolType } from '../service/matchService'

/**
 * 服务端预取下来的首屏数据（由根布局传给 AppShell）。
 *
 * 只放「页面首帧必须要有」的数据；每加一个路由在这里加一个可选字段，
 * 客户端对应页面用「有就用、没有就自己拉」的方式消费。
 */

export type InitialMatches = {
  pool: MatchPoolType
  cards: MatchCard[]
  dataAsOf: string | null
}

export type InitialResults = {
  /** 预取的是哪一天的赛果（北京时间的「今天」） */
  date: string
  items: MatchResultItem[]
  updatedAt: string | null
}

export type SsrInitialData = {
  path: string
  matches?: InitialMatches
  results?: InitialResults
}
