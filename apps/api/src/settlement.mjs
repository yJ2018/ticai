/**
 * 投注结算：纯函数，输入「投注单 + 腿 + 赛果」，输出中奖与理论奖金。
 *
 * 规则对齐竞彩：
 *   - 每注 2 元，倍数相乘；
 *   - 过关（n串1）：一注里的 n 场全中才算中；复式每场多选，按组合拆成多注；
 *   - 一场多选时最多只有一个选项能中，所以中奖注数 = 命中组合数；
 *   - 奖金 = Σ(命中组合的赔率连乘) × 2 × 倍数。
 *
 * 赛果缺失（还没开奖）一律 pending，不猜。
 */

const PASS_TYPE_PATTERN = /^(\d+)串1$/

export function parsePassType(passType) {
  const match = PASS_TYPE_PATTERN.exec(String(passType ?? '').trim())
  return match ? Number(match[1]) : 0
}

export function formatPassType(passType) {
  const need = parsePassType(passType)
  return need >= 2 ? `${need}串1` : String(passType ?? '')
}

/**
 * 复式注数与理论最高奖金。
 *
 * units   = Σ_k Σ_组合 Π(该场选项数)
 * maxBonus= Σ_k Σ_组合 Π(该场最大赔率) × 2 × 倍数
 *
 * 两组组合和都用「每场一个因子」的初等对称和 DP，O(n·k)，不用枚举组合。
 */
export function computePlanMetrics({ groups, passTypes, multiple = 1 }) {
  const factors = groups.map((group) => ({
    count: Math.max(1, Number(group.optionCount) || 1),
    maxOdds: Math.max(0, Number(group.maxOdds) || 0),
  }))
  const maxK = Math.max(0, ...passTypes.map(parsePassType))
  const countSum = elementarySums(factors.map((item) => item.count), maxK)
  const oddsSum = elementarySums(factors.map((item) => item.maxOdds), maxK)

  let units = 0
  let maxBonus = 0
  for (const passType of passTypes) {
    const need = parsePassType(passType)
    if (need < 2 || need > factors.length) {
      continue
    }
    units += countSum[need] ?? 0
    maxBonus += (oddsSum[need] ?? 0) * 2 * multiple
  }

  return {
    units: Math.round(units),
    amount: Number((units * 2 * multiple).toFixed(2)),
    maxBonus: Number(maxBonus.toFixed(2)),
  }
}

function elementarySums(values, maxK) {
  const dp = new Array(maxK + 1).fill(0)
  dp[0] = 1
  for (const value of values) {
    for (let k = maxK; k >= 1; k -= 1) {
      dp[k] += dp[k - 1] * value
    }
  }
  return dp
}

function* combinations(items, k, start = 0, acc = []) {
  if (acc.length === k) {
    yield acc.slice()
    return
  }
  for (let index = start; index <= items.length - (k - acc.length); index += 1) {
    acc.push(items[index])
    yield* combinations(items, k, index + 1, acc)
    acc.pop()
  }
}

/**
 * 单腿判定：won / lost / pending。
 *
 * result 的字段名与 `repos/results.mjs#toResultShape` 一致：
 *   { settled, homeScore, awayScore, homeHalfScore, awayHalfScore, goalLine,
 *     had, hhad, ttg, crs, hafu }
 */
export function legOutcome(leg, result) {
  if (!result || !result.settled) {
    return 'pending'
  }

  const pool = String(leg.pool ?? '')
  const optionKey = String(leg.optionKey ?? '')

  if (pool === 'had') {
    if (!result.had) {
      return 'pending'
    }
    return optionKey === result.had ? 'won' : 'lost'
  }

  if (pool === 'hhad') {
    const key = optionKey.replace(/^rq-/, '')
    // 让球数用「下注时的」那一档：开奖行的让球数偶尔会缺失
    if (Number.isFinite(result.homeScore) && Number.isFinite(result.awayScore)) {
      const line = Number.isFinite(leg.goalLine) ? leg.goalLine : (result.goalLine ?? 0)
      const home = result.homeScore + line
      const expected = home > result.awayScore ? 'h' : home === result.awayScore ? 'd' : 'a'
      return key === expected ? 'won' : 'lost'
    }
    if (!result.hhad) {
      return 'pending'
    }
    return key === result.hhad ? 'won' : 'lost'
  }

  if (pool === 'ttg') {
    if (!Number.isFinite(result.ttg)) {
      return 'pending'
    }
    return optionKey === `s${result.ttg}` ? 'won' : 'lost'
  }

  if (pool === 'crs') {
    if (!result.crs) {
      return 'pending'
    }
    return optionKey === result.crs ? 'won' : 'lost'
  }

  if (pool === 'hafu') {
    if (!result.hafu) {
      return 'pending'
    }
    return optionKey === result.hafu ? 'won' : 'lost'
  }

  return 'pending'
}

/**
 * @param {object} bet    { passTypes, multiple }
 * @param {Array}  legs   每行一条：{ sportteryMatchId, pool, optionKey, odds, goalLine }
 * @param {Map}    results sportteryMatchId → 赛果
 */
export function settleBet({ bet, legs, results }) {
  const multiple = Math.max(1, Number(bet.multiple) || 1)
  const passTypes = Array.isArray(bet.passTypes) && bet.passTypes.length > 0
    ? bet.passTypes
    : [`${Math.max(2, new Set(legs.map((leg) => leg.sportteryMatchId)).size)}串1`]

  const byMatch = new Map()
  for (const leg of legs) {
    const id = Number(leg.sportteryMatchId)
    if (!byMatch.has(id)) {
      byMatch.set(id, [])
    }
    byMatch.get(id).push(leg)
  }

  const groups = Array.from(byMatch.entries()).map(([matchId, groupLegs]) => {
    const result = results.get(matchId) ?? null
    const legStates = groupLegs.map((leg) => ({
      ...leg,
      outcome: legOutcome(leg, result),
    }))
    const winning = legStates.filter((state) => state.outcome === 'won')
    return {
      matchId,
      result,
      legStates,
      winning,
      pending: legStates.some((state) => state.outcome === 'pending'),
      lost: legStates.every((state) => state.outcome === 'lost'),
    }
  })

  let payout = 0
  const passTypeDetails = []

  for (const passType of passTypes) {
    const need = parsePassType(passType)
    if (need < 2 || need > groups.length) {
      continue
    }

    let wonUnits = 0
    let passPayout = 0

    for (const combo of combinations(groups, need)) {
      if (combo.some((group) => group.pending || group.winning.length === 0)) {
        continue
      }
      const odds = combo.reduce((product, group) => product * Number(group.winning[0].odds || 0), 1)
      wonUnits += 1
      passPayout += 2 * multiple * odds
    }

    passPayout = Number(passPayout.toFixed(2))
    payout += passPayout
    passTypeDetails.push({
      passType,
      need,
      totalUnits: elementarySums(groups.map((group) => Math.max(1, group.legStates.length)), need)[need] ?? 0,
      wonUnits,
      payout: passPayout,
    })
  }

  payout = Number(payout.toFixed(2))

  const anyPending = groups.some((group) => group.pending)
  const status = anyPending ? 'pending' : payout > 0 ? 'won' : 'lost'

  return {
    status,
    payout,
    passTypeDetails,
    legs: groups.flatMap((group) =>
      group.legStates.map((state) => ({
        id: state.id,
        sportteryMatchId: group.matchId,
        pool: state.pool,
        optionKey: state.optionKey,
        optionLabel: state.optionLabel,
        odds: Number(state.odds) || 0,
        outcome: state.outcome,
        result: group.result
          ? {
              settled: group.result.settled,
              homeScore: group.result.homeScore,
              awayScore: group.result.awayScore,
              homeHalfScore: group.result.homeHalfScore,
              awayHalfScore: group.result.awayHalfScore,
            }
          : null,
      })),
    ),
  }
}
