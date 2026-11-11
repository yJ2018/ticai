/**
 * 双色球 / 快乐8 推演结果的类型（与 Python/Node 分析快照一一对应）。
 *
 * 只保留展示需要的字段，不复制任何算法：
 *   - 双色球：红球 12 码池 + 蓝球 4 码池，另给主推 6+1；
 *   - 快乐8：选十 10 码主推 + 20 码参考池。
 */

export type PoolWindows = {
  short: number
  recent: number
  long: number
}

export type PoolRankedNumber = {
  number: number
  score: number
  shortCount: number
  recentCount: number
  longCount: number
  missSpan: number
  /** 双色球：上一期重号 / 邻号标记（0/1） */
  repeat?: number
  neighbor?: number
}

export type PoolTargets = {
  averageSum: number
  averageSpan: number
  averageOdd: number
  averageBig: number
  averageZones: number[]
  commonOddEven: string
  commonBigSmall: string
  commonZones: string
}

export type PoolMetrics = {
  sum: number
  span: number
  odd: number
  even: number
  big: number
  small: number
  zones: number[]
  consecutive: number
}

export type SsqRedAnalysis = {
  poolSize: number
  /** 红球 12 码池（升序） */
  picks: number[]
  /** 主推 6 红（升序） */
  primary: number[]
  alternates: number[]
  ranking: PoolRankedNumber[]
  hot: PoolRankedNumber[]
  cold: PoolRankedNumber[]
  overdue: PoolRankedNumber[]
  targets: PoolTargets
  metrics: PoolMetrics
}

export type SsqBlueMetrics = {
  odd: number
  even: number
  big: number
  small: number
}

export type SsqBlueAnalysis = {
  poolSize: number
  /** 蓝球 4 码池（升序） */
  picks: number[]
  /** 主推 1 蓝 */
  primary: number[]
  alternates: number[]
  ranking: PoolRankedNumber[]
  hot: PoolRankedNumber[]
  cold: PoolRankedNumber[]
  overdue: PoolRankedNumber[]
  metrics: SsqBlueMetrics
}

export type SsqRecommendation = {
  windows: PoolWindows
  sampleSize: number
  red: SsqRedAnalysis
  blue: SsqBlueAnalysis
  reasons: string[]
}

export type Kl8Recommendation = {
  windows: PoolWindows
  sampleSize: number
  picks: {
    /** 选十 10 码（升序） */
    primary: number[]
    /** 20 码参考池（升序） */
    pool: number[]
  }
  /** 选十主推的四区名额分配，如 [2,2,3,3] */
  allocation: number[]
  ranking: PoolRankedNumber[]
  hot: PoolRankedNumber[]
  cold: PoolRankedNumber[]
  overdue: PoolRankedNumber[]
  targets: PoolTargets
  metrics: PoolMetrics
  poolMetrics: PoolMetrics
  reasons: string[]
}
