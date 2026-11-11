/**
 * 号码池型推荐命中记录的类型（大乐透 / 双色球 / 快乐8）。
 *
 * 与 `GET /api/analysis/lottery/hits` 一一对应：
 *   items   每期开奖前给出的推荐、实际开奖、命中个数与奖级；
 *   summary 累计命中 / 命中率 / 30–1000 期窗口 / 命中分布 / 奖级分布。
 *
 * 第 N 期的推荐只用第 N-1 期为止的数据（`throughIssue` 可自证没偷看当期）。
 */

export type RecommendationHitGame = {
  gameKey: string
  gameNo: string
  name: string
  positional: boolean
  mainCount: number | null
  mainMax: number | null
  extraCount: number
  extraMax: number | null
  category: string | null
}

export type RecommendationHitItem = {
  issue: string
  issueSeq: number
  drawDate: string
  throughIssue: string | null
  throughIssueSeq: number | null
  prediction: {
    main: number[]
    extra: number[]
    primaryMain?: number[]
    primaryExtra?: number[]
    poolMain?: number[]
    poolExtra?: number[]
  }
  actual: {
    main: number[]
    extra: number[]
  }
  hits: {
    main: number
    extra: number
    total: number
  }
  ticket: {
    tier: string | null
    tiers: Array<{ tier: string; units: number }>
    winningUnits: number
  }
}

export type RecommendationHitShape = {
  mainMax: number
  extraMax: number
  actualMain: number
  actualExtra: number
  pickMain: number
  pickExtra: number
  mainPickRate: number
  extraPickRate: number
  expectedMainHits: number
  expectedExtraHits: number
}

export type RecommendationHitWindow = {
  window: number
  samples: number
  mainHits: number
  extraHits: number
  avgMainHits: number
  avgExtraHits: number
  avgTotalHits: number
  captureRate: number
  lift: number
  winningIssues: number
  winningRate: number
}

export type RecommendationHitSummary = {
  version: string
  kind: string
  configKey: string
  gameKey: string
  shape: RecommendationHitShape
  baseline: {
    mainPickRate: number
    extraPickRate: number
    expectedMainHits: number
    expectedExtraHits: number
    expectedTotalHits: number
  }
  sample: {
    gameKey?: string
    kind?: string
    fromIssue: string | null
    fromIssueSeq: number | null
    fromDrawDate: string | null
    toIssue: string | null
    toIssueSeq: number | null
    toDrawDate: string | null
    drawCount: number
  }
  overall: {
    samples: number
    mainHits: number
    extraHits: number
    totalHits: number
    avgMainHits: number
    avgExtraHits: number
    avgTotalHits: number
    captureRate: number
    extraCaptureRate: number
    lift: number
    extraLift: number
    winningIssues: number
    winningRate: number
    bestTier: string | null
  }
  windows: RecommendationHitWindow[]
  distribution: {
    main: Array<{ hits: number; count: number; rate: number }>
    extra: Array<{ hits: number; count: number; rate: number }>
  }
  tiers: Array<{ tier: string; count: number; rate: number }>
  rolling: Array<{
    issue: string
    issueSeq: number
    drawDate: string
    main: number
    extra: number
    total: number
    tier: string | null
  }>
  recentCoverage: number
}

export type RecommendationHitResponse = {
  game: RecommendationHitGame
  kind: string
  configKey: string
  ready: boolean
  reason?: string
  summary: RecommendationHitSummary | null
  sample: RecommendationHitSummary['sample'] | null
  items: RecommendationHitItem[]
  missing: string[]
  stale: boolean
  triggered: boolean
  computedAt?: string | null
}
