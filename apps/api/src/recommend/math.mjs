/**
 * 推荐引擎的数学层（纯函数，可单测）。
 *
 * 口径：
 *   官方赔率 → 幂法去水得到市场概率 → 用市场概率反推 λ（预期进球）
 *   → Dixon-Coles 比分矩阵 → 各玩法概率。
 *
 * 为什么用幂法去水（p_i = (1/o_i)^k，Σp_i = 1）而不是简单归一：
 *   简单归一把庄家的抽水按比例摊，会系统性高估长赔（低概率）选项，
 *   于是「模型概率 > 市场概率」永远出现在冷门上——这正是旧的客户端推荐
 *   会挑出 22.00 这种票的原因之一。
 */

const MAX_GOALS = 8

export function poissonPmf(lambda, max = MAX_GOALS) {
  const out = new Array(max + 1)
  let term = Math.exp(-lambda)
  out[0] = term
  for (let k = 1; k <= max; k += 1) {
    term = (term * lambda) / k
    out[k] = term
  }
  return out
}

/**
 * 去水：幂法。赔率 < 2 项或含非法值时返回 null（调用方跳过该组）。
 */
export function devig(odds) {
  const valid = odds.filter((value) => Number.isFinite(value) && value > 1)
  if (valid.length !== odds.length || valid.length < 2) {
    return null
  }

  const raw = valid.map((value) => 1 / value)
  const sumAt = (k) => raw.reduce((total, value) => total + Math.pow(value, k), 0)

  // k=1 时 Σ(1/o) > 1（含水），k 增大则单调下降；二分找到 Σ = 1
  let low = 0.5
  let high = 4
  if (sumAt(low) < 1) {
    // 赔率异常（含水为负），退化为比例归一
    const total = raw.reduce((left, right) => left + right, 0)
    return raw.map((value) => value / total)
  }
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2
    if (sumAt(mid) > 1) {
      low = mid
    } else {
      high = mid
    }
  }
  const k = (low + high) / 2
  return raw.map((value) => Math.pow(value, k))
}

/**
 * Dixon-Coles 比分矩阵：独立泊松 + 低比分相关性修正。
 * rho < 0 时略微提高 0:0 / 1:1，压低 1:0 / 0:1（经验值 −0.05）。
 */
export function scoreMatrix(lambdaHome, lambdaAway, { max = MAX_GOALS, rho = -0.05 } = {}) {
  const home = poissonPmf(lambdaHome, max)
  const away = poissonPmf(lambdaAway, max)
  const matrix = []
  let total = 0

  for (let h = 0; h <= max; h += 1) {
    const row = new Array(max + 1)
    for (let a = 0; a <= max; a += 1) {
      let p = home[h] * away[a]
      if (h === 0 && a === 0) p *= 1 - lambdaHome * lambdaAway * rho
      else if (h === 0 && a === 1) p *= 1 + lambdaHome * rho
      else if (h === 1 && a === 0) p *= 1 + lambdaAway * rho
      else if (h === 1 && a === 1) p *= 1 - rho
      row[a] = Math.max(p, 0)
      total += row[a]
    }
    matrix.push(row)
  }

  if (total > 0) {
    for (const row of matrix) {
      for (let a = 0; a < row.length; a += 1) {
        row[a] /= total
      }
    }
  }
  return matrix
}

/** 让球线：体彩 hhad.goalLine 形如 "+1" / "-1"，空串按 0 处理。 */
export function parseGoalLine(value) {
  const text = String(value ?? '').replace(/[^0-9+.-]/g, '')
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 比分矩阵 → 推荐用到的三个玩法概率（胜平负 / 让球胜平负 / 总进球）。
 * 比分/半全场方差太大，不进入推荐（回测里也证明过没有可利用的稳定优势）。
 */
export function poolProbabilities(matrix, goalLine = 0) {
  const had = { h: 0, d: 0, a: 0 }
  const hhad = { h: 0, d: 0, a: 0 }
  const ttg = { s0: 0, s1: 0, s2: 0, s3: 0, s4: 0, s5: 0, s6: 0, s7: 0 }

  for (let h = 0; h < matrix.length; h += 1) {
    for (let a = 0; a < matrix[h].length; a += 1) {
      const p = matrix[h][a]
      if (p <= 0) {
        continue
      }
      if (h > a) had.h += p
      else if (h === a) had.d += p
      else had.a += p

      const diff = h + goalLine - a
      if (diff > 0) hhad.h += p
      else if (diff === 0) hhad.d += p
      else hhad.a += p

      const total = h + a
      ttg[total >= 7 ? 's7' : `s${total}`] += p
    }
  }

  return { had, hhad, ttg }
}

/** 与 Python 版一致的快路径：CDF + 卷积直接算胜平负与总进球，不构造 9×9 矩阵。 */
function hadTtgFromPmfs(lambdaHome, lambdaAway) {
  const home = poissonPmf(lambdaHome)
  const away = poissonPmf(lambdaAway)
  const cdfHome = []
  let acc = 0
  for (const value of home) {
    acc += value
    cdfHome.push(acc)
  }

  const had = { h: 0, d: 0, a: 0 }
  for (let a = 0; a < away.length; a += 1) {
    const pa = away[a]
    if (pa <= 0) continue
    had.h += pa * (1 - cdfHome[a])
    had.d += pa * home[a]
    had.a += pa * (cdfHome[a] - home[a])
  }

  const ttg = { s0: 0, s1: 0, s2: 0, s3: 0, s4: 0, s5: 0, s6: 0, s7: 0 }
  for (let a = 0; a < away.length; a += 1) {
    const pa = away[a]
    if (pa <= 0) continue
    for (let h = 0; h < home.length; h += 1) {
      const total = h + a
      ttg[total >= 7 ? 's7' : `s${total}`] += pa * home[h]
    }
  }

  return { had, ttg }
}

/** 由市场概率反推 λ：粗网格全扫 + 局部细化，目标 = 胜平负 + 总进球。 */
export function fitLambdas({ hadTarget, ttgTarget, goalLine = 0 }) {
  const targets = []
  if (hadTarget) {
    targets.push({ weight: 1, keys: ['h', 'd', 'a'], values: [hadTarget.h, hadTarget.d, hadTarget.a] })
  }
  if (ttgTarget) {
    targets.push({
      weight: 0.6,
      keys: ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'],
      values: ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'].map((key) => ttgTarget[key] ?? 0),
    })
  }
  if (targets.length === 0) {
    return null
  }

  const error = (lambdaHome, lambdaAway) => {
    // 与 Python 版完全同一套误差：CDF + 卷积快路径（不构造矩阵）。
    const { had, ttg } = hadTtgFromPmfs(lambdaHome, lambdaAway)
    let score = 0
    for (const target of targets) {
      for (let i = 0; i < target.keys.length; i += 1) {
        const key = target.keys[i]
        const model = target.keys.length === 3 ? had[key] : ttg[key]
        const delta = model - target.values[i]
        score += target.weight * delta * delta
      }
    }
    return score
  }

  let best = { home: 1.3, away: 1.1, error: Number.POSITIVE_INFINITY }
  for (let h = 40; h <= 320; h += 8) {
    for (let a = 30; a <= 300; a += 8) {
      const lambdaHome = h / 100
      const lambdaAway = a / 100
      const value = error(lambdaHome, lambdaAway)
      if (value < best.error) {
        best = { home: lambdaHome, away: lambdaAway, error: value }
      }
    }
  }
  for (let h = -7; h <= 7; h += 1) {
    for (let a = -7; a <= 7; a += 1) {
      const lambdaHome = Math.max(0.2, best.home + h / 100)
      const lambdaAway = Math.max(0.2, best.away + a / 100)
      const value = error(lambdaHome, lambdaAway)
      if (value < best.error) {
        best = { home: lambdaHome, away: lambdaAway, error: value }
      }
    }
  }

  return {
    home: Number(best.home.toFixed(3)),
    away: Number(best.away.toFixed(3)),
    error: Number(Math.sqrt(best.error).toFixed(5)),
  }
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}
