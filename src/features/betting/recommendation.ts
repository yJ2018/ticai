import { type RecommendPlan, type RecommendPool, type RecommendScope } from '../../api/recommendApi'
import { type MatchPoolType } from '../../service/matchService'

/**
 * 推荐相关的类型与映射：服务端方案 → 投注单选项。
 *
 * 概率、串关、风控全在服务端（apps/api/src/recommend/），这里只做「怎么落到投注单」。
 */

export type ParlayLeg = {
  matchId: number
  matchNo: string
  teams: string
  pick: { key: string; label: string; odd: number }
}

export function toRecommendPool(poolType: MatchPoolType): RecommendPool {
  // 前端没有独立的「让球」标签页：胜平负标签里同时有 had 与 hhad，交给服务端按同一组处理
  return poolType
}

export function planToLegs(plan: RecommendPlan): ParlayLeg[] {
  return plan.legs.map((leg) => ({
    matchId: leg.matchId,
    matchNo: leg.matchNo,
    teams: leg.teams,
    pick: { key: leg.optionKey, label: leg.optionLabel, odd: leg.odd },
  }))
}

export function scopeLabel(scope: RecommendScope) {
  return scope === 'today' ? '今天' : '跨天'
}
