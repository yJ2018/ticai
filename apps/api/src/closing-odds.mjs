/**
 * 开奖赔率（停售前最后一份官方赔率）提取。
 *
 * 数据来源两处，结构相同：
 *   - `match_result.closing_odds`：赛果首次入库时把最后一份快照整包固化（快照只留 120 天）；
 *   - `match_odds_snapshot.odds`：还没固化的场次回退到该场最新的一份。
 *
 * 结构：{ had: {h,d,a}, hhad: {h,d,a,goalLine}, ttg: {s0..s7}, crs: {...}, hafu: {...} }，
 * 与 `bet_leg.option_key` 的 key 完全对齐（让球去掉 `rq-` 前缀）。
 *
 * 口径校验：赛果接口自带的 h/d/a 就是官方开奖赔率（胜平负），与快照收盘值逐场一致。
 *
 * 只做「把某个投注选项在这份赔率里的数值取出来」：
 *   - 让球盘口对不上（收盘让球数与下注时不同）时返回 null，不拿另一档的赔率硬算；
 *   - 上游赔率是字符串（'1.52'），统一转成两位小数；字段缺失 / 为 '0' / 非数字一律 null。
 */

export const CLOSING_POOLS = ['had', 'hhad', 'ttg', 'crs', 'hafu']

/** 投注选项 key → 赔率对象里的 key（只有让球带前缀）。 */
export function oddsKeyOf(pool, optionKey) {
  const key = String(optionKey ?? '')
  return pool === 'hhad' ? key.replace(/^rq-/, '') : key
}

/** 让球数：上游给 '+1' / '-1' / ''，转成整数；缺失返回 null。 */
export function goalLineOf(odds, pool = 'hhad') {
  const block = odds?.[pool]
  const raw = block?.goalLineValue ?? block?.goalLine
  const text = String(raw ?? '').trim()
  if (!text) {
    return null
  }
  const value = Number(text)
  return Number.isFinite(value) ? Math.trunc(value) : null
}

function toOdds(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1) {
    return null
  }
  return Number(number.toFixed(2))
}

/**
 * 取某个投注选项的开奖赔率。
 *
 * @param {object|null} odds      全玩法赔率（closing_odds / 快照的 odds）
 * @param {string} pool           had | hhad | ttg | crs | hafu
 * @param {string} optionKey      bet_leg.option_key（如 rq-h / s3 / s02s01 / hh）
 * @param {number|null} goalLine  下注时的让球数，仅让球盘用
 * @returns {number|null}
 */
export function pickClosingOdds(odds, pool, optionKey, goalLine = null) {
  if (!odds || typeof odds !== 'object' || !CLOSING_POOLS.includes(pool)) {
    return null
  }

  const block = odds[pool]
  if (!block || typeof block !== 'object') {
    return null
  }

  if (pool === 'hhad') {
    const closingLine = goalLineOf(odds, 'hhad')
    const betLine = goalLine === null || goalLine === undefined || !Number.isFinite(Number(goalLine))
      ? null
      : Math.trunc(Number(goalLine))
    // 只比得出来的情况：两边都有值且不一致，说明收盘换了盘口，这注的赔率不可比
    if (closingLine !== null && betLine !== null && closingLine !== betLine) {
      return null
    }
  }

  return toOdds(block[oddsKeyOf(pool, optionKey)])
}
