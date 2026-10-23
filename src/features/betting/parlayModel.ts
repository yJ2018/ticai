import {
  type MatchCard,
  type MatchCardOption,
  type MatchMarkets,
  type MatchPoolType,
} from '../../service/matchService'
import { formatPlanOptionLabel, getMaxParlayLegs } from './betSlipMath'

/**
 * 一键串关的模型层（纯函数，可在浏览器里跑完）。
 *
 * 口径对齐 ticai-football skill：
 *   官方赔率 → 去水得到市场概率 → 用 1X2 反推 λ_home / λ_away → 泊松推各玩法概率
 *   → EV = p_model × odds − 1 → 每场三选（首选 / 稳健）→ 按置信度与 EV 取最大串关。
 *
 * 简化处（会在界面上明说）：没有伤停/天气，λ 只由赔率反推；半全场按上下半场各 λ/2 近似。
 */

const MAX_GOALS = 8
const HALF_MAX_GOALS = 5

export type LambdaFit = {
  home: number
  away: number
  /** 1x2 = 用胜平负赔率反推；ttg = 只有总进球赔率，只能推总进球再按 57/43 拆分 */
  source: '1x2' | 'ttg'
}

export type MarketEntry = {
  option: MatchCardOption
  odd: number
  /** 组内去水后的市场概率 */
  marketP: number
}

export type AnalyzedOption = {
  key: string
  label: string
  odd: number
  marketP: number
  modelP: number
  fairOdd: number
  ev: number
}

export type Confidence = 'high' | 'medium' | 'low'

export type MatchAnalysis = {
  card: MatchCard
  fit: LambdaFit
  options: AnalyzedOption[]
  primary: AnalyzedOption
  steady: AnalyzedOption
  confidence: Confidence
}

export type ParlayLeg = {
  matchId: number
  matchNo: string
  teams: string
  pick: AnalyzedOption
  role: '首选' | '稳健'
  confidence: Confidence
  lambda: LambdaFit
  ev: number
}

export type ParlayPlan = {
  legs: ParlayLeg[]
  totalOdd: number
  hitProb: number
  expectedReturn: number
  risk: '低' | '中' | '高'
  maxLegs: number
  note: string
}

/* ── 基础概率 ─────────────────────────────────────────── */

function parseOdd(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 1 ? parsed : 0
}

function poisson(lambda: number, max: number): number[] {
  const out = new Array<number>(max + 1)
  let term = Math.exp(-lambda)
  out[0] = term
  for (let k = 1; k <= max; k += 1) {
    term = (term * lambda) / k
    out[k] = term
  }
  return out
}

/** 组内去水：1/odds 归一化。赔率不足两个时返回空。 */
function devig(odds: number[]): number[] | null {
  const inverses = odds.map((odd) => (odd > 1 ? 1 / odd : 0))
  const sum = inverses.reduce((left, right) => left + right, 0)
  if (!(sum > 0) || inverses.some((value) => value <= 0)) {
    return null
  }
  return inverses.map((value) => value / sum)
}

function scoreMatrix(fit: LambdaFit): number[][] {
  const home = poisson(fit.home, MAX_GOALS)
  const away = poisson(fit.away, MAX_GOALS)
  const matrix: number[][] = []
  for (let h = 0; h <= MAX_GOALS; h += 1) {
    const row = new Array<number>(MAX_GOALS + 1)
    for (let a = 0; a <= MAX_GOALS; a += 1) {
      row[a] = home[h] * away[a]
    }
    matrix.push(row)
  }
  return matrix
}

/* ── 拟合 λ ───────────────────────────────────────────── */

/** 0.2–3.6 的 λ 网格，泊松向量只算一次，后面 4761 次组合全是查表。 */
const LAMBDA_GRID: Array<{ lambda: number; pmf: number[] }> = (() => {
  const grid: Array<{ lambda: number; pmf: number[] }> = []
  for (let value = 20; value <= 360; value += 5) {
    const lambda = value / 100
    grid.push({ lambda, pmf: poisson(lambda, MAX_GOALS) })
  }
  return grid
})()

function fitFromOneXTwo(markets: MatchMarkets | undefined): LambdaFit | null {
  const had = markets?.had
  const odds = [parseOdd(had?.h), parseOdd(had?.d), parseOdd(had?.a)]
  if (odds.some((odd) => odd === 0)) {
    return null
  }
  const target = devig(odds)
  if (!target) {
    return null
  }

  // 总进球也参与拟合：只靠 1X2 定不下 λ_total，会让"1 球"永远显示 +30% 的假优势
  const ttgKeys = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7']
  const ttgOdds = ttgKeys.map((key) => parseOdd(markets?.ttg?.[key]))
  const ttgTarget = ttgOdds.filter((odd) => odd > 1).length >= 4 ? devig(ttgOdds) : null
  const TTG_WEIGHT = 0.8

  let bestHome = 1.35
  let bestAway = 1.1
  let bestScore = Number.POSITIVE_INFINITY

  for (const homeRow of LAMBDA_GRID) {
    for (const awayRow of LAMBDA_GRID) {
      let pHome = 0
      let pDraw = 0
      let pAway = 0
      const pTotals = [0, 0, 0, 0, 0, 0, 0, 0]
      for (let h = 0; h < homeRow.pmf.length; h += 1) {
        for (let a = 0; a < awayRow.pmf.length; a += 1) {
          const probability = homeRow.pmf[h] * awayRow.pmf[a]
          if (h > a) {
            pHome += probability
          } else if (h === a) {
            pDraw += probability
          } else {
            pAway += probability
          }
          pTotals[Math.min(h + a, 7)] += probability
        }
      }

      let score =
        (pHome - target[0]) ** 2 + (pDraw - target[1]) ** 2 + (pAway - target[2]) ** 2

      if (ttgTarget) {
        for (let index = 0; index < pTotals.length; index += 1) {
          const delta = pTotals[index] - ttgTarget[index]
          score += TTG_WEIGHT * delta * delta
        }
      }

      if (score < bestScore) {
        bestScore = score
        bestHome = homeRow.lambda
        bestAway = awayRow.lambda
      }
    }
  }

  return { home: bestHome, away: bestAway, source: '1x2' }
}

function fitFromTotalGoals(markets: MatchMarkets | undefined): LambdaFit | null {
  const ttg = markets?.ttg
  const keys = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7']
  const odds = keys.map((key) => parseOdd(ttg?.[key]))
  if (odds.filter((odd) => odd > 1).length < 4) {
    return null
  }
  const target = devig(odds)
  if (!target) {
    return null
  }

  let bestLambda = 2.6
  let bestScore = Number.POSITIVE_INFINITY
  for (let value = 40; value <= 600; value += 5) {
    const lambda = value / 100
    const pmf = poisson(lambda, MAX_GOALS)
    let tail = 1
    const probabilities: number[] = []
    for (let k = 0; k <= 6; k += 1) {
      probabilities.push(pmf[k])
      tail -= pmf[k]
    }
    probabilities.push(Math.max(tail, 0))

    let score = 0
    for (let index = 0; index < probabilities.length; index += 1) {
      const delta = probabilities[index] - target[index]
      score += delta * delta
    }
    if (score < bestScore) {
      bestScore = score
      bestLambda = lambda
    }
  }

  return { home: Number((bestLambda * 0.57).toFixed(2)), away: Number((bestLambda * 0.43).toFixed(2)), source: 'ttg' }
}

export function fitLambdas(markets: MatchMarkets | undefined): LambdaFit | null {
  return fitFromOneXTwo(markets) ?? fitFromTotalGoals(markets)
}

/* ── 各玩法模型概率 ───────────────────────────────────── */

const CRS_LISTED = new Set([
  's01s00', 's02s00', 's02s01', 's03s00', 's03s01', 's03s02',
  's04s00', 's04s01', 's04s02', 's05s00', 's05s01', 's05s02',
  's00s00', 's01s01', 's02s02', 's03s03',
  's00s01', 's00s02', 's01s02', 's00s03', 's01s03', 's02s03',
  's00s04', 's01s04', 's02s04', 's00s05', 's01s05', 's02s05',
])

function scoreKey(home: number, away: number) {
  return `s${String(home).padStart(2, '0')}s${String(away).padStart(2, '0')}`
}

export function modelProbabilities(fit: LambdaFit, markets: MatchMarkets | undefined): Map<string, number> {
  const matrix = scoreMatrix(fit)
  const probabilities = new Map<string, number>()
  const add = (key: string, value: number) => {
    probabilities.set(key, (probabilities.get(key) ?? 0) + value)
  }

  const line = Number(markets?.hhad?.goalLine ?? markets?.hhad?.goalLineValue ?? 0)
  const shift = Number.isFinite(line) ? line : 0

  let listedHome = 0
  let listedDraw = 0
  let listedAway = 0

  for (let h = 0; h <= MAX_GOALS; h += 1) {
    for (let a = 0; a <= MAX_GOALS; a += 1) {
      const probability = matrix[h][a]
      if (h > a) {
        add('h', probability)
      } else if (h === a) {
        add('d', probability)
      } else {
        add('a', probability)
      }

      const diff = h + shift - a
      if (diff > 0) {
        add('rq-h', probability)
      } else if (diff === 0) {
        add('rq-d', probability)
      } else {
        add('rq-a', probability)
      }

      const total = h + a
      add(total >= 7 ? 's7' : `s${total}`, probability)

      const key = scoreKey(h, a)
      if (CRS_LISTED.has(key)) {
        add(key, probability)
        if (h > a) {
          listedHome += probability
        } else if (h === a) {
          listedDraw += probability
        } else {
          listedAway += probability
        }
      }
    }
  }

  add('s1sh', Math.max((probabilities.get('h') ?? 0) - listedHome, 0))
  add('s1sd', Math.max((probabilities.get('d') ?? 0) - listedDraw, 0))
  add('s1sa', Math.max((probabilities.get('a') ?? 0) - listedAway, 0))

  // 半全场：上下半场各 λ/2，独立泊松
  const firstHome = poisson(fit.home / 2, HALF_MAX_GOALS)
  const firstAway = poisson(fit.away / 2, HALF_MAX_GOALS)
  const sign = (delta: number) => (delta > 0 ? 'h' : delta === 0 ? 'd' : 'a')
  for (let h1 = 0; h1 <= HALF_MAX_GOALS; h1 += 1) {
    for (let a1 = 0; a1 <= HALF_MAX_GOALS; a1 += 1) {
      const firstP = firstHome[h1] * firstAway[a1]
      if (firstP === 0) {
        continue
      }
      for (let h2 = 0; h2 <= HALF_MAX_GOALS; h2 += 1) {
        for (let a2 = 0; a2 <= HALF_MAX_GOALS; a2 += 1) {
          const probability = firstP * firstHome[h2] * firstAway[a2]
          if (probability === 0) {
            continue
          }
          add(sign(h1 - a1) + sign(h1 + h2 - (a1 + a2)), probability)
        }
      }
    }
  }

  return probabilities
}

/* ── 市场条目（组内去水） ─────────────────────────────── */

export function readMarketEntries(card: MatchCard, poolType: MatchPoolType): MarketEntry[] {
  const groups =
    poolType === 'mixed'
      ? [...(card.optionGroups ?? []), ...(card.mixedSections ?? []).flatMap((section) => section.groups)]
      : (card.optionGroups ?? [])

  const entries: MarketEntry[] = []

  for (const group of groups) {
    const valid = group.options
      .map((option) => ({ option, odd: parseOdd(option.value) }))
      .filter((item) => item.odd > 0)
    if (valid.length < 2) {
      continue
    }
    const normalized = devig(valid.map((item) => item.odd))
    if (!normalized) {
      continue
    }
    valid.forEach((item, index) => {
      entries.push({ option: item.option, odd: item.odd, marketP: normalized[index] })
    })
  }

  return entries
}

/* ── 单场三选 ─────────────────────────────────────────── */

export function assembleAnalysis(
  card: MatchCard,
  poolType: MatchPoolType,
  entries: MarketEntry[],
  fit: LambdaFit,
  probabilities: Map<string, number>,
): MatchAnalysis | null {
  const options: AnalyzedOption[] = []

  for (const entry of entries) {
    const modelP = probabilities.get(entry.option.key)
    if (modelP === undefined || modelP <= 0) {
      continue
    }
    options.push({
      key: entry.option.key,
      label: formatPlanOptionLabel(poolType, entry.option, card),
      odd: entry.odd,
      marketP: entry.marketP,
      modelP,
      fairOdd: 1 / modelP,
      ev: modelP * entry.odd - 1,
    })
  }

  if (options.length === 0) {
    return null
  }

  const withEdge = options.filter((option) => option.modelP >= 0.2)
  const evPool = withEdge.length > 0 ? withEdge : options
  const primary = evPool.reduce((best, option) => (option.ev > best.ev ? option : best))

  const steadyPool = options.filter((option) => option.odd >= 1.3)
  const steady = (steadyPool.length > 0 ? steadyPool : options).reduce((best, option) =>
    option.modelP > best.modelP ? option : best,
  )

  const gap = Math.abs(primary.modelP - primary.marketP)
  const confidence: Confidence =
    fit.source === 'ttg'
      ? 'low'
      : primary.modelP >= 0.25 && gap < 0.25
        ? 'high'
        : 'medium'

  return { card, fit, options, primary, steady, confidence }
}

/* ── 串关 ─────────────────────────────────────────────── */

/** 风险调整：数据越可靠，同样的 EV 越可信 */
const CONFIDENCE_BONUS: Record<Confidence, number> = { high: 0.03, medium: 0, low: -0.05 }

export function buildParlayPlan(analyses: MatchAnalysis[], poolType: MatchPoolType): ParlayPlan | null {
  if (analyses.length < 2) {
    return null
  }

  const maxLegs = getMaxParlayLegs(poolType)
  const adjusted = (analysis: MatchAnalysis) =>
    analysis.confidence === 'low' ? analysis.steady.ev : analysis.primary.ev
  const ranked = [...analyses].sort(
    (left, right) =>
      adjusted(right) + CONFIDENCE_BONUS[right.confidence] -
      (adjusted(left) + CONFIDENCE_BONUS[left.confidence]),
  )

  const legs: ParlayLeg[] = ranked.slice(0, maxLegs).map((analysis) => ({
    matchId: analysis.card.id,
    matchNo: analysis.card.matchNo ?? '周?000',
    teams: analysis.card.title,
    pick: analysis.confidence === 'low' ? analysis.steady : analysis.primary,
    role: analysis.confidence === 'low' ? '稳健' : '首选',
    confidence: analysis.confidence,
    lambda: analysis.fit,
    ev: analysis.confidence === 'low' ? analysis.steady.ev : analysis.primary.ev,
  }))

  if (legs.length < 2) {
    return null
  }

  const totalOdd = legs.reduce((product, leg) => product * leg.pick.odd, 1)
  const hitProb = legs.reduce((product, leg) => product * leg.pick.modelP, 1)
  const expectedReturn = hitProb * totalOdd
  const risk: ParlayPlan['risk'] =
    expectedReturn >= 1 ? (hitProb >= 0.08 ? '低' : '中') : '高'

  const note =
    expectedReturn >= 1
      ? '模型给出的期望回报不低于 1，仍属概率优势，不代表稳赢。'
      : '模型期望回报低于 1（负期望），建议缩短串关或只作概率参考。'

  return { legs, totalOdd, hitProb, expectedReturn, risk, maxLegs, note }
}

/**
 * 负期望时给一个更短的替代方案（默认 3 串 1）。
 * 少一场就少一层抽水，命中率也会显著回升。
 */
export function shortenPlan(plan: ParlayPlan, count: number): ParlayPlan {
  const legs = plan.legs.slice(0, Math.min(count, plan.legs.length))
  const totalOdd = legs.reduce((product, leg) => product * leg.pick.odd, 1)
  const hitProb = legs.reduce((product, leg) => product * leg.pick.modelP, 1)
  const expectedReturn = hitProb * totalOdd
  const risk: ParlayPlan['risk'] =
    expectedReturn >= 1 ? (hitProb >= 0.08 ? '低' : '中') : '高'

  return {
    ...plan,
    legs,
    totalOdd,
    hitProb,
    expectedReturn,
    risk,
    note: '缩短后的保守方案：少一场就少一层抽水，命中率更高，但仍不保证盈利。',
  }
}
