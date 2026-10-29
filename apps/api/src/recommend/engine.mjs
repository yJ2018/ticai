import { clamp, fitLambdas, poolProbabilities, scoreMatrix } from './math.mjs'
import { POOL_LABEL, marketProbabilities, optionLabel, readPools } from './odds.mjs'

/**
 * 投注推荐引擎（服务端，纯函数）。目标不是「猜中」，而是别把明显不成立的东西推给用户：
 *
 *   1. 概率以**市场**为基准：幂法去水后的隐含概率，是先验，也是下限；
 *   2. 「数据」只做**有界修正**：近况（本库已结束比赛）与伤停各自最多挪动 λ ±12%，
 *      样本越多修正越大（n/(n+4)），没有样本就不修正——旧的客户端做法是拿同一份赔率
 *      反推 λ 再和赔率比大小，必然在拟合噪声处「发现优势」，于是挑出 22.00 的冷门；
 *   3. 串关有硬约束：最多 3 场、总赔率 ≤ 8、单腿融合概率 ≥ 0.44、每条腿赔率 ≤ 3.3，
 *      2串1 命中率必须 ≥ 26%。达不到就返回「今天没有值得推的方案」，而不是硬凑。
 *
 * 输出里带 coverage / filtered，UI 可以老实告诉用户「这一场为什么没被选上」。
 */

const MAX_LEGS = 3

/**
 * 前端标签页 ↔ 可推荐玩法的对应关系：
 *   胜平负标签页里同时有 had 与 hhad（让球），所以这两组一起参与；
 *   比分 / 半全场不参与（方差太大，回测也没有稳定优势）。
 */
const POOL_SETS = {
  had: ['had', 'hhad'],
  hhad: ['hhad'],
  ttg: ['ttg'],
  mixed: ['had', 'hhad', 'ttg'],
}

const POOL_SET_LABEL = {
  had: '胜平负 + 让球',
  hhad: '让球胜平负',
  ttg: '总进球',
  mixed: '混合玩法',
}

const TIERS = {
  safe: [
    { marketP: 0.42, blendP: 0.52, minOdd: 1.25, maxOdd: 2.15 },
    { marketP: 0.36, blendP: 0.47, minOdd: 1.25, maxOdd: 2.45 },
  ],
  aggressive: [
    { marketP: 0.3, blendP: 0.44, minOdd: 1.4, maxOdd: 3.3 },
    { marketP: 0.26, blendP: 0.4, minOdd: 1.4, maxOdd: 3.6 },
  ],
}

const PLAN_SPECS = {
  safe: { id: 'safe', label: '稳健 2串1', legs: 2, maxTotalOdd: 4.2, minHitProb: 0.26, objective: 'hit' },
  aggressive: {
    id: 'aggressive',
    label: '进取 3串1',
    legs: 3,
    maxTotalOdd: 8,
    minHitProb: 0.15,
    objective: 'ev',
  },
}

function beijingDate(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`
}

function buildHistoryIndex(finished) {
  const index = new Map()
  const push = (teamId, entry) => {
    if (!index.has(teamId)) {
      index.set(teamId, [])
    }
    index.get(teamId).push(entry)
  }

  for (const match of finished) {
    if (match.homeTeamId) {
      push(match.homeTeamId, {
        kickoffAt: match.kickoffAt,
        gf: match.homeScore,
        ga: match.awayScore,
        home: true,
      })
    }
    if (match.awayTeamId) {
      push(match.awayTeamId, {
        kickoffAt: match.kickoffAt,
        gf: match.awayScore,
        ga: match.homeScore,
        home: false,
      })
    }
  }
  for (const list of index.values()) {
    list.sort((left, right) => (left.kickoffAt < right.kickoffAt ? 1 : -1))
  }
  return index
}

/** 某队在某时刻前的近 N 场：胜/平/负、进/失球、主客场拆分。 */
function teamForm(index, teamId, before, limit = 6) {
  const list = teamId ? (index.get(teamId) ?? []).filter((entry) => entry.kickoffAt < before).slice(0, limit) : []
  let wins = 0
  let draws = 0
  let losses = 0
  let goalsFor = 0
  let goalsAgainst = 0
  let homeWins = 0
  let homeDraws = 0
  let homeLosses = 0
  let homeMatches = 0

  for (const entry of list) {
    if (entry.gf > entry.ga) wins += 1
    else if (entry.gf === entry.ga) draws += 1
    else losses += 1
    goalsFor += entry.gf
    goalsAgainst += entry.ga
    if (entry.home) {
      homeMatches += 1
      if (entry.gf > entry.ga) homeWins += 1
      else if (entry.gf === entry.ga) homeDraws += 1
      else homeLosses += 1
    }
  }

  return {
    n: list.length,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    points: wins * 3 + draws,
    homeMatches,
    homeWins,
    homeDraws,
    homeLosses,
  }
}

/** 近况修正：有界（±12%），样本越多越敢动；没有样本就完全不动。 */
function formAdjustment(homeForm, awayForm) {
  const sample = Math.min(homeForm.n, awayForm.n)
  if (sample === 0) {
    return { home: 1, away: 1, sample: 0 }
  }
  const strength = (form) => form.points / (3 * form.n)
  const diff = strength(homeForm) - strength(awayForm)
  const damp = sample / (sample + 4)
  const delta = clamp(0.35 * diff * damp, -0.12, 0.12)
  return { home: 1 + delta, away: 1 - delta, sample }
}

/** 伤停修正：每缺 1 人 −3%，最多 −12%（只动自己的进攻 λ）。 */
function injuryAdjustment(injury) {
  const count = injury?.count ?? 0
  return 1 - 0.03 * Math.min(count, 4)
}

function planNote(spec, hitProb, expectedReturn) {
  const expectation =
    expectedReturn >= 1
      ? '融合概率下的期望回报略高于 1，仍不代表稳赢。'
      : `融合概率下的期望回报 ${expectedReturn.toFixed(2)}×（庄家抽水仍在），只作概率参考。`
  return `${spec.legs} 场串关，融合命中率 ${percent(hitProb)}。${expectation}`
}

/** 从候选里挑 size 场，满足总赔率与命中率约束；目标函数按方案类型区分。 */
function bestCombo(candidates, spec, objective) {
  const pool = candidates.slice(0, 12)
  let best = null

  const consider = (legs) => {
    if (legs.length !== spec.legs) {
      return
    }
    const totalOdd = legs.reduce((product, leg) => product * leg.odd, 1)
    const hitProb = legs.reduce((product, leg) => product * leg.blendP, 1)
    if (totalOdd > spec.maxTotalOdd || hitProb < spec.minHitProb) {
      return
    }
    // 同联赛的腿略微降权：同轮同联赛的赛果相关性高，串在一起并没有降低风险
    const leagues = new Set(legs.map((leg) => leg.league))
    const diversityPenalty = leagues.size === legs.length ? 0 : 0.02
    const value =
      objective === 'hit'
        ? hitProb - diversityPenalty
        : hitProb * totalOdd - 0.35 * Math.max(0, totalOdd - 4) - diversityPenalty
    if (!best || value > best.value) {
      best = { legs, totalOdd, hitProb, value }
    }
  }

  if (spec.legs === 2) {
    for (let i = 0; i < pool.length; i += 1) {
      for (let j = i + 1; j < pool.length; j += 1) {
        consider([pool[i], pool[j]])
      }
    }
  } else {
    for (let i = 0; i < pool.length; i += 1) {
      for (let j = i + 1; j < pool.length; j += 1) {
        for (let k = j + 1; k < pool.length; k += 1) {
          consider([pool[i], pool[j], pool[k]])
        }
      }
    }
  }
  return best
}

function pickTier(candidates, tiers, spec) {
  for (const tier of tiers) {
    const eligible = candidates.filter(
      (item) =>
        item.marketP >= tier.marketP &&
        item.blendP >= tier.blendP &&
        item.odd >= tier.minOdd &&
        item.odd <= tier.maxOdd,
    )
    if (eligible.length >= spec.legs) {
      const combo = bestCombo(eligible, spec, spec.objective)
      if (combo) {
        return { ...combo, tier }
      }
    }
  }
  return null
}

function describeLeg(leg, injury, homeForm, awayForm) {
  const reasons = []
  const formText = (form, place) =>
    form.n > 0
      ? `${place}近 ${form.n} 场 ${form.wins}胜${form.draws}平${form.losses}负（场均进 ${(
          form.goalsFor / form.n
        ).toFixed(1)} 失 ${(form.goalsAgainst / form.n).toFixed(1)}）`
      : ''

  if (leg.pool === 'ttg') {
    const parts = [formText(homeForm, '主队'), formText(awayForm, '客队')].filter(Boolean)
    reasons.push(parts.length > 0 ? parts.join('；') : '本库没有这两队的近期战绩，概率只按市场与伤停估')
  } else {
    const isHome = leg.side !== 'away'
    const form = isHome ? homeForm : awayForm
    if (form.n > 0) {
      const venue =
        form.homeMatches > 0
          ? `，同侧近 ${form.homeMatches} 场 ${form.homeWins}胜${form.homeDraws}平${form.homeLosses}负`
          : ''
      reasons.push(
        `${formText(form, isHome ? '主队' : '客队')}${venue}`,
      )
    } else {
      reasons.push('本库没有这队的近期战绩，概率只按市场与伤停估')
    }
  }

  const sides = leg.pool === 'ttg' ? ['home', 'away'] : [leg.side === 'away' ? 'away' : 'home']
  for (const side of sides) {
    const injurySide = injury?.[side]
    if (injurySide && injurySide.count > 0) {
      const names = injurySide.names.slice(0, 2).join('、')
      reasons.push(
        `${side === 'home' ? '主队' : '客队'}伤停 ${injurySide.count} 人${names ? `（${names}）` : ''}，λ 下调 ${(
          Math.min(injurySide.count, 4) * 3
        ).toFixed(0)}%`,
      )
    }
  }

  reasons.push(
    `市场 ${percent(leg.marketP)} → 模型 ${percent(leg.modelP)} → 融合 ${percent(leg.blendP)}（${leg.edge >= 0 ? '+' : ''}${(leg.edge * 100).toFixed(1)} 个百分点）`,
  )
  return reasons
}

/**
 * @param {object} input
 * @param {Array} input.slate     在售赛事（data.loadSlate）
 * @param {Map}   input.injuries  伤停（data.loadInjuries）
 * @param {Array} input.finished  已结束比赛（data.loadFinishedMatches）
 * @param {string} input.pool     had | hhad | ttg | mixed
 * @param {string} input.scope    today | all
 */
export function buildRecommendation({
  slate,
  injuries = new Map(),
  finished = [],
  pool = 'mixed',
  scope = 'today',
  now = new Date(),
}) {
  const today = beijingDate(now)
  const allowed = POOL_SETS[pool] ?? []
  const historyIndex = buildHistoryIndex(finished)

  const inScope = slate.filter((match) => (scope === 'today' ? match.businessDate === today : true))
  const coverage = {
    onSale: slate.length,
    inScope: inScope.length,
    withOdds: 0,
    withInjury: 0,
    withHistory: 0,
    historyMatches: finished.length,
    today,
  }
  const filtered = { noOdds: 0, noMarket: 0, noCandidate: 0, probTooLow: 0, oddsOutOfBand: 0, invalidPool: allowed.length === 0 }

  const candidates = []
  const analyzed = []

  for (const match of inScope) {
    if (!match.odds) {
      filtered.noOdds += 1
      continue
    }
    coverage.withOdds += 1

    const pools = readPools(match.odds)
    const market = marketProbabilities(pools)
    const injury = injuries.get(match.matchId) ?? null
    if (injury) {
      coverage.withInjury += 1
    }

    const before = match.kickoffAt ?? new Date(now).toISOString()
    const homeForm = teamForm(historyIndex, match.homeTeamId, before)
    const awayForm = teamForm(historyIndex, match.awayTeamId, before)
    if (homeForm.n > 0 && awayForm.n > 0) {
      coverage.withHistory += 1
    }

    const fit = fitLambdas({
      hadTarget: market.had,
      ttgTarget: market.ttg,
      goalLine: pools.hhadLine,
    })
    if (!fit) {
      filtered.noMarket += 1
      continue
    }

    const form = formAdjustment(homeForm, awayForm)
    const injuryHome = injuryAdjustment(injury?.home)
    const injuryAway = injuryAdjustment(injury?.away)
    const homeScale = clamp(form.home * injuryHome, 0.75, 1.3)
    const awayScale = clamp(form.away * injuryAway, 0.75, 1.3)

    const model = poolProbabilities(
      scoreMatrix(fit.home * homeScale, fit.away * awayScale),
      pools.hhadLine,
    )

    // 融合权重：市场为主导，数据样本越多、伤停越确定，模型权重越大（上限 0.42）
    const sample = Math.min(homeForm.n, awayForm.n)
    let weight = 0.06 * sample
    if (injury) weight += 0.04
    weight = clamp(weight, 0.02, 0.42)

    const matchCandidates = []
    for (const poolKey of allowed) {
      const marketPool = market[poolKey]
      const modelPool = model[poolKey]
      if (!marketPool || !modelPool) {
        continue
      }
      const oddsPool = pools[poolKey]
      for (const key of Object.keys(marketPool)) {
        const odd = oddsPool[key]
        const marketP = marketPool[key]
        const modelP = modelPool[key] ?? 0
        if (!odd || !marketP || !modelP) {
          continue
        }
        const blendP = weight * modelP + (1 - weight) * marketP
        const edge = blendP * odd - 1
        const confidence = blendP >= 0.6 && marketP >= 0.55 ? 'high' : blendP >= 0.5 ? 'medium' : 'low'
        matchCandidates.push({
          matchId: match.matchId,
          matchNo: match.matchNo,
          league: match.league,
          teams: `${match.homeName} vs ${match.awayName}`,
          kickoffAt: match.kickoffAt,
          pool: poolKey,
          poolLabel: POOL_LABEL[poolKey],
          optionKey: poolKey === 'hhad' ? `rq-${key}` : key,
          optionLabel: optionLabel(poolKey, key, pools.hhadLine),
          side: key === 'a' ? 'away' : 'home',
          odd,
          marketP,
          modelP,
          blendP,
          edge,
          confidence,
          weight,
          goalLine: pools.hhadLine,
          lambda: { home: fit.home * homeScale, away: fit.away * awayScale },
          sample: {
            homeMatches: homeForm.n,
            awayMatches: awayForm.n,
            injuriesHome: injury?.home?.count ?? 0,
            injuriesAway: injury?.away?.count ?? 0,
          },
        })
      }
    }

    if (matchCandidates.length === 0) {
      filtered.noMarket += 1
      continue
    }

    matchCandidates.sort((left, right) => right.blendP - left.blendP)
    const best = matchCandidates[0]
    const safeTier = TIERS.safe[0]
    const aggressiveTier = TIERS.aggressive[0]

    let rejectReason = ''
    if (best.marketP < aggressiveTier.marketP) {
      rejectReason = `市场概率 ${percent(best.marketP)} 太低，不推`
      filtered.probTooLow += 1
    } else if (best.odd > aggressiveTier.maxOdd) {
      rejectReason = `最可能选项赔率 ${best.odd.toFixed(2)} 仍偏高（>${aggressiveTier.maxOdd}），不推`
      filtered.oddsOutOfBand += 1
    }

    const passSafe =
      best.marketP >= safeTier.marketP &&
      best.blendP >= safeTier.blendP &&
      best.odd >= safeTier.minOdd &&
      best.odd <= safeTier.maxOdd
    const passAggressive =
      best.marketP >= aggressiveTier.marketP &&
      best.blendP >= aggressiveTier.blendP &&
      best.odd >= aggressiveTier.minOdd &&
      best.odd <= aggressiveTier.maxOdd

    if (!passSafe && !passAggressive) {
      filtered.noCandidate += 1
      if (!rejectReason) {
        rejectReason = `融合概率 ${percent(best.blendP)} / 赔率 ${best.odd.toFixed(2)} 未达门槛`
      }
    }

    const entry = {
      ...best,
      passSafe,
      passAggressive,
      rejectReason,
      reasons: describeLeg(best, injury, homeForm, awayForm),
      alternatives: matchCandidates.slice(1, 3),
    }
    candidates.push(entry)
    analyzed.push(entry)
  }

  const plans = []

  // 单关：串关每多一层就多一层抽水，能推单关就先把单关摆出来。
  // 第二档是给总进球这种「单场概率上限只有 30% 左右」的玩法留的：只推一注，不串。
  const SINGLE_TIERS = [
    { minBlendP: 0.5, minOdd: 1.2, maxOdd: 2.15 },
    { minBlendP: 0.2, minOdd: 1.2, maxOdd: 4.5 },
  ]
  for (const tier of SINGLE_TIERS) {
    const pool = candidates
      .filter((item) => item.blendP >= tier.minBlendP && item.odd >= tier.minOdd && item.odd <= tier.maxOdd)
      .sort((left, right) => right.blendP - left.blendP)
    if (pool.length === 0) {
      continue
    }
    const leg = pool[0]
    const lowProbability = leg.blendP < 0.4
    plans.push({
      id: 'single',
      label: lowProbability ? '单关（低概率玩法）' : '单关首选',
      risk: lowProbability ? '中' : '低',
      legs: [leg],
      totalOdd: Number(leg.odd.toFixed(2)),
      hitProb: Number(leg.blendP.toFixed(4)),
      expectedReturn: Number((leg.blendP * leg.odd).toFixed(3)),
      note: lowProbability
        ? `这个玩法单场概率上限就低（${percent(leg.blendP)}），只给单关参考，不串关。`
        : `单场命中率 ${percent(leg.blendP)}。串关每多一层就多一层抽水，只想跟一场时优先看这个。`,
    })
    break
  }

  for (const kind of ['safe', 'aggressive']) {
    const spec = PLAN_SPECS[kind]
    const tier = TIERS[kind]
    const eligible = candidates.filter((item) => (kind === 'safe' ? item.passSafe : item.passAggressive))
    const combo = eligible.length >= spec.legs ? pickTier(eligible, tier, spec) : null
    if (!combo) {
      continue
    }
    const legs = combo.legs.map((leg) => ({
      ...leg,
      reasons: leg.reasons,
    }))
    plans.push({
      id: spec.id,
      label: spec.label,
      risk: kind === 'safe' ? '低' : '中',
      legs,
      totalOdd: Number(combo.totalOdd.toFixed(2)),
      hitProb: Number(combo.hitProb.toFixed(4)),
      expectedReturn: Number((combo.hitProb * combo.totalOdd).toFixed(3)),
      note: planNote(spec, combo.hitProb, combo.hitProb * combo.totalOdd),
    })
  }

  const notes = []
  if (allowed.length === 0) {
    notes.push('比分 / 半全场方差太大，不进入推荐；可切到胜平负、让球或总进球再试。')
  }
  if (coverage.historyMatches < 30) {
    notes.push('本库复盘样本只有几十场，模型只做轻量修正，概率以市场为基准。')
  }
  if (coverage.withInjury === 0) {
    notes.push('这一批赛事还没有抓到伤停数据，修正项按 0 处理。')
  }
  if (allowed.length === 1 && allowed[0] === 'ttg') {
    notes.push('总进球单场概率上限通常只有 25–35%，这里只给单关参考，不做串关。')
  }
  if (plans.length === 0) {
    notes.push('今天没有达到门槛的方案：宁可空着，也不硬凑高赔长串。')
  }

  return {
    generatedAt: new Date().toISOString(),
    scope,
    pool,
    poolLabel: POOL_SET_LABEL[pool] ?? pool,
    coverage,
    filtered,
    plans,
    candidates: candidates
      .sort((left, right) => right.blendP - left.blendP)
      .slice(0, 12)
      .map((item) => ({
        matchId: item.matchId,
        matchNo: item.matchNo,
        league: item.league,
        teams: item.teams,
        kickoffAt: item.kickoffAt,
        pool: item.pool,
        optionKey: item.optionKey,
        optionLabel: item.optionLabel,
        odd: item.odd,
        marketP: item.marketP,
        modelP: item.modelP,
        blendP: item.blendP,
        edge: item.edge,
        weight: item.weight,
        confidence: item.confidence,
        passSafe: item.passSafe,
        passAggressive: item.passAggressive,
        rejectReason: item.rejectReason,
        reasons: item.reasons,
      })),
    analyzed: analyzed.length,
    notes,
  }
}

export { MAX_LEGS, POOL_LABEL }
