/**
 * 「赔率接近」信号（纯函数）。
 *
 * 只做一件事：在同一玩法里取赔率最低的两个选项，如果两者相差不超过 6%，
 * 就认为它们赔率接近；再用推荐引擎已经算好的融合概率（市场 + 近况/伤停修正）
 * 指出模型更偏向哪一个。这样投注页上的标注不是「赔率低就看好」，而是真的用了
 * 双方近期战绩与进球数据。
 *
 * 为什么不取全市场最接近的相邻两项：总进球 6/7 球这种尾部选项经常只差 0.1，
 * 但和比赛走势无关。只看最低两档，才对应「最低 / 倒数第二低」这个用户能理解的比较。
 */

export const CLOSE_ODDS_GAP = 0.08

function round(value, digits = 4) {
  if (!Number.isFinite(value)) {
    return null
  }
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

/** 总进球用「2球 / 3球」这种短标签，让球沿用行首的 [-1] 只写「让胜」。 */
function shortLabel(candidate) {
  if (candidate.pool === 'ttg') {
    const value = String(candidate.optionKey).replace(/^s/, '')
    return value === '7' ? '7+球' : `${value}球`
  }
  if (candidate.pool === 'hhad') {
    const result = String(candidate.optionLabel ?? '').split(' ').pop()
    return result ? `让${result}` : candidate.optionLabel
  }
  return candidate.optionLabel
}

function buildNote(pool, low, high, gap, preferred) {
  const labels = `${shortLabel(low)} / ${shortLabel(high)}`
  const gapText = `${(gap * 100).toFixed(1)}%`
  const preferredLabel = shortLabel(preferred)

  if (pool === 'ttg') {
    const goal = preferred.goalExpectation
    const formMatches = goal ? Math.min(goal.homeMatches, goal.awayMatches) : 0
    const goalText = goal
      ? `期望总进球 ${goal.expectedTotal.toFixed(1)}（市场 ${goal.marketTotal.toFixed(1)}）`
      : ''
    if (goal && formMatches >= 3) {
      return (
        `${labels} 赔率接近（差 ${gapText}）；` +
        `双方近 ${goal.homeMatches}/${goal.awayMatches} 场，${goalText}，模型偏向 ${preferredLabel}`
      )
    }
    return `${labels} 赔率接近（差 ${gapText}）；${goalText}，分析略偏 ${preferredLabel}`
  }

  const sample = preferred.sample
  const formMatches = sample ? Math.min(sample.homeMatches, sample.awayMatches) : 0
  if (formMatches >= 3) {
    return (
      `${labels} 赔率接近（差 ${gapText}）；近 ${sample.homeMatches}/${sample.awayMatches} 场修正后，` +
      `模型偏向 ${preferredLabel}（融合 ${(preferred.blendP * 100).toFixed(1)}%）`
    )
  }
  return (
    `${labels} 赔率接近（差 ${gapText}）；分析略偏 ${preferredLabel}` +
    `（融合 ${(preferred.blendP * 100).toFixed(1)}%）`
  )
}

/**
 * @param {Array<object>} candidates 推荐引擎里的单场候选（同一场、各玩法）
 * @returns {Array<object>} 每个玩法最多一条信号
 */
export function buildCloseSignals(candidates) {
  const groups = new Map()
  for (const candidate of candidates ?? []) {
    if (!candidate || !Number.isFinite(candidate.odd) || candidate.odd <= 1) {
      continue
    }
    if (!groups.has(candidate.pool)) {
      groups.set(candidate.pool, [])
    }
    groups.get(candidate.pool).push(candidate)
  }

  const signals = []
  for (const [pool, list] of groups) {
    if (list.length < 2) {
      continue
    }

    const sorted = [...list].sort(
      (left, right) => left.odd - right.odd || left.optionKey.localeCompare(right.optionKey),
    )
    const [low, high] = sorted
    const gap = (high.odd - low.odd) / low.odd
    if (!(gap >= 0) || gap > CLOSE_ODDS_GAP) {
      continue
    }

    const preferred = high.blendP > low.blendP ? high : low
    const note = buildNote(pool, low, high, gap, preferred)

    signals.push({
      matchId: preferred.matchId,
      matchNo: preferred.matchNo,
      teams: preferred.teams,
      pool,
      poolLabel: preferred.poolLabel,
      gap: round(gap, 4),
      note,
      options: [low, high].map((item) => ({
        optionKey: item.optionKey,
        optionLabel: shortLabel(item),
        odd: round(item.odd, 2),
        marketP: round(item.marketP, 4),
        modelP: round(item.modelP, 4),
        blendP: round(item.blendP, 4),
        preferred: item === preferred,
      })),
      sample: {
        homeMatches: preferred.sample?.homeMatches ?? 0,
        awayMatches: preferred.sample?.awayMatches ?? 0,
      },
      goalExpectation:
        pool === 'ttg' && preferred.goalExpectation
          ? {
              expectedTotal: round(preferred.goalExpectation.expectedTotal, 2),
              marketTotal: round(preferred.goalExpectation.marketTotal, 2),
              homeMatches: preferred.goalExpectation.homeMatches ?? 0,
              awayMatches: preferred.goalExpectation.awayMatches ?? 0,
            }
          : undefined,
    })
  }

  return signals
}
