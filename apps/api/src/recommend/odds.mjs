import { devig, parseGoalLine } from './math.mjs'

/**
 * 赔率解析（纯函数）：jsonb → 可比数字，再按组去水。
 * 推荐引擎与回测共用同一套口径，避免「回测一套、线上另一套」。
 */

export const POOL_ORDER = ['had', 'hhad', 'ttg']
export const POOL_LABEL = { had: '胜平负', hhad: '让球胜平负', ttg: '总进球' }

export function oddsNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 1 ? parsed : 0
}

export function readPools(odds) {
  const line = parseGoalLine(odds?.hhad?.goalLine ?? odds?.hhad?.goalLineValue)
  const ttg = {}
  for (let i = 0; i <= 7; i += 1) {
    ttg[`s${i}`] = oddsNumber(odds?.ttg?.[`s${i}`])
  }
  return {
    had: {
      h: oddsNumber(odds?.had?.h),
      d: oddsNumber(odds?.had?.d),
      a: oddsNumber(odds?.had?.a),
    },
    hhad: {
      h: oddsNumber(odds?.hhad?.h),
      d: oddsNumber(odds?.hhad?.d),
      a: oddsNumber(odds?.hhad?.a),
    },
    hhadLine: line,
    ttg,
  }
}

/** 组内去水；某项缺赔率时整组作废（宁可不推，也不要拿半套赔率算概率）。 */
export function marketProbabilities(pools) {
  const had = devig([pools.had.h, pools.had.d, pools.had.a])
  const hhad = devig([pools.hhad.h, pools.hhad.d, pools.hhad.a])
  const ttg = devig([0, 1, 2, 3, 4, 5, 6, 7].map((index) => pools.ttg[`s${index}`]))
  return {
    had: had ? { h: had[0], d: had[1], a: had[2] } : null,
    hhad: hhad ? { h: hhad[0], d: hhad[1], a: hhad[2] } : null,
    ttg: ttg
      ? { s0: ttg[0], s1: ttg[1], s2: ttg[2], s3: ttg[3], s4: ttg[4], s5: ttg[5], s6: ttg[6], s7: ttg[7] }
      : null,
  }
}

export function optionLabel(pool, key, line = 0) {
  if (pool === 'had') {
    return { h: '胜', d: '平', a: '负' }[key] ?? key
  }
  if (pool === 'hhad') {
    const tag = line > 0 ? `+${line}` : `${line}`
    return `让球(${tag}) ${({ h: '胜', d: '平', a: '负' })[key] ?? key}`
  }
  return key === 's7' ? '总进球 7+' : `总进球 ${key.slice(1)}`
}
