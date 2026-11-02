/**
 * 逐期参考归档的类型。
 *
 * 与 `GET /api/analysis/lottery/track` 返回一一对应：
 *   items   每期开奖前给出的参考、逐位命中、组合命中；
 *   summary 全量归档的命中率 / 分位偏差 / 号码偏差 / 滚动曲线。
 *
 * 第 N 期的参考只用第 N-1 期为止的数据（`throughIssue` 单独带出，可自证没偷看当期）。
 */

export type PredictionTrackPosition = {
  position: number
  /** 该期这一位的 3 个候选（Top1 是第一个） */
  picks: number[]
  actual: number | null
  /** 实际号码在 0–9 排名里的名次（1–10）；七星彩末位 10–14 时为 null */
  rank: number | null
  hitTop1: boolean
  hitTop3: boolean
}

export type PredictionTrackCombination = {
  value: string
  score: number
  /** 这注组合和当期开奖对上了几位（0–5） */
  matched: number
}

export type PredictionTrackItem = {
  issue: string
  issueSeq: number
  drawDate: string
  throughIssue: string | null
  throughIssueSeq: number | null
  actual: number[]
  positions: PredictionTrackPosition[]
  combinations: PredictionTrackCombination[]
  top1Hits: number
  top3Hits: number
  bestComboMatch: number
}

export type PredictionTrackOverall = {
  samples: number
  positions: number
  top1Hits: number
  top3Hits: number
  top1Rate: number
  top3Rate: number
  top1Deviation: number
  top3Deviation: number
  top1Lift: number
  top3Lift: number
  /** 每期平均命中几位（0–5） */
  avgPositionHits: number
  /** 实际号码平均落在第几位（1–10，随机期望 5.5） */
  avgRank: number | null
}

export type PredictionTrackPositionStat = {
  position: number
  samples: number
  top1Hits: number
  top3Hits: number
  top1Rate: number
  top3Rate: number
  top1Deviation: number
  top3Deviation: number
  top1Lift: number
  top3Lift: number
  avgRank: number | null
  recentTop3Rate: number
  recentTop1Rate: number
}

export type PredictionTrackWindow = {
  window: number
  samples: number
  top1Hits: number
  top3Hits: number
  top1Rate: number
  top3Rate: number
}

export type PredictionTrackDigitStat = {
  digit: number
  picked: number
  pickedRate: number
  actual: number
  actualRate: number
  /** 正数 = 模型比实际更爱选这个数字（高估） */
  deviation: number
}

export type PredictionTrackCombinationStat = {
  issues: number
  samples: number
  exactHits: number
  exactIssues: number
  exactRate: number
  avgMatched: number
  best: number
  distribution: Array<{ matched: number; count: number; rate: number }>
}

export type PredictionTrackSample = {
  gameKey?: string
  positionCount?: number
  fromIssue: string | null
  fromIssueSeq: number | null
  fromDrawDate: string | null
  toIssue: string | null
  toIssueSeq: number | null
  toDrawDate: string | null
  drawCount: number
}

export type PredictionTrackSummary = {
  version: string
  configKey: string
  positionCount: number
  baseline: { top1: number; top3: number }
  sample: PredictionTrackSample
  overall: PredictionTrackOverall
  positions: PredictionTrackPositionStat[]
  windows: PredictionTrackWindow[]
  digits: PredictionTrackDigitStat[][]
  combinations: PredictionTrackCombinationStat
  rolling: Array<{ issue: string; issueSeq: number; top1: number; top3: number }>
  recentCoverage: number
}

export type PredictionTrackGame = {
  gameKey: string
  gameNo: string
  name: string
  positional: boolean
  mainCount: number
}

export type PredictionTrackEngine = {
  version: string
  digest: string
  runtime: string
}

export type PredictionTrackResponse = {
  game: PredictionTrackGame
  configKey: string
  ready: boolean
  reason?: string
  engine: PredictionTrackEngine
  summary: PredictionTrackSummary | null
  sample: PredictionTrackSample | null
  items: PredictionTrackItem[]
  /** 请求了但归档里还没有的期号（例如刚开奖、爬虫还没补） */
  missing: string[]
  stale: boolean
  /** true = 这次请求触发了服务端补算 */
  triggered: boolean
  computedAt?: string | null
}
