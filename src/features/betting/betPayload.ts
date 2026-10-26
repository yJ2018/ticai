import type { BetLegInput, CreateBetInput, MarketPool } from '../../api/betApi'
import type { MatchCard } from '../../service/matchService'
import { flattenOptionGroups } from './betSlipMath'

/**
 * 投注单 → 保存接口的入参。
 *
 * 只把「在投注界面里真正勾选且赔率有效」的选项带上；
 * 赔率取的是当前展示值（快照），保存后不会再随盘口变化。
 */

export function buildBetLegs(
  items: MatchCard[],
  selectedOptionKeys: Record<number, string[]>,
): BetLegInput[] {
  const legs: BetLegInput[] = []
  const seen = new Set<string>()

  for (const item of items) {
    const keys = selectedOptionKeys[item.id] ?? []
    if (keys.length === 0) {
      continue
    }

    for (const option of flattenOptionGroups(item)) {
      if (!keys.includes(option.key)) {
        continue
      }

      const odds = Number(option.value)
      if (!Number.isFinite(odds) || odds < 1) {
        continue
      }

      const dedupeKey = `${item.id}:${option.pool}:${option.key}`
      if (seen.has(dedupeKey)) {
        continue
      }
      seen.add(dedupeKey)

      legs.push({
        sportteryMatchId: item.id,
        matchNumStr: item.matchNo,
        leagueName: item.subtitle,
        homeName: item.homeTeam,
        awayName: item.awayTeam,
        kickoffAt: toKickoffIso(item.time),
        pool: option.pool as MarketPool,
        optionKey: option.key,
        optionLabel: option.label,
        odds,
        goalLine: option.pool === 'hhad' ? goalLineOf(item) : null,
      })
    }
  }

  return legs
}

export function buildBetPayload({
  items,
  selectedOptionKeys,
  passTypes,
  multiple,
  title,
}: {
  items: MatchCard[]
  selectedOptionKeys: Record<number, string[]>
  passTypes: string[]
  multiple: number
  title?: string
}): CreateBetInput {
  const legs = buildBetLegs(items, selectedOptionKeys)
  const matchCount = new Set(legs.map((leg) => leg.sportteryMatchId)).size

  // 投注栏在「只选 1 场」时会兜底显示最大过关方式（如 6串1），
  // 那个值不能直接提交：服务端会按实际场次校验，这里先按场次过滤。
  const legalPassTypes = passTypes.filter((passType) => {
    const need = Number.parseInt(passType, 10)
    return Number.isFinite(need) ? need >= 2 && need <= matchCount : false
  })

  return {
    title,
    passTypes: legalPassTypes,
    multiple,
    legs,
  }
}

/** 让球数取该场「让球胜平负」的那一档，结算时按它重算。 */
function goalLineOf(item: MatchCard) {
  const raw = item.markets?.hhad?.goalLine ?? item.markets?.hhad?.goalLineValue
  const value = Number(String(raw ?? '').trim())
  return Number.isFinite(value) ? Math.trunc(value) : null
}

/** '2026-10-25 19:00:00'（北京时间）→ ISO 字符串。 */
function toKickoffIso(text: string | undefined) {
  const value = String(text ?? '').trim()
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/.exec(value)
  if (!match) {
    return null
  }
  const seconds = match[3] ?? ':00'
  return `${match[1]}T${match[2]}${seconds}+08:00`
}
