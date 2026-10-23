import { type MatchCard, type MatchCardOption, type MatchPoolType } from '../../service/matchService'

export const PLAN_MODAL_ANIMATION_MS = 260

export type PlanEntryOption = {
  key: string
  label: string
  value: string
}

export type PlanEntry = {
  id: number
  order: number
  matchNo: string
  teams: string
  kickoffTime: string
  selectedOptions: PlanEntryOption[]
}

type SportteryTaxInfo = {
  taxAmount: number
  afterTaxAmount: number
}

/** 各玩法的最大串关数：胜平负 8、进球数 6、比分/半全场 4、混合 5 */
export function getPassTypeOptions(poolType: MatchPoolType) {
  if (poolType === 'had') {
    return buildPassTypeRange(8)
  }

  if (poolType === 'ttg') {
    return buildPassTypeRange(6)
  }

  if (poolType === 'crs' || poolType === 'hafu') {
    return buildPassTypeRange(4)
  }

  return buildPassTypeRange(5)
}

function buildPassTypeRange(max: number) {
  const result: string[] = []
  for (let size = 2; size <= max; size += 1) {
    result.push(`${size}串1`)
  }
  return result
}

export function getMaxPassTypeFromOptions(options: string[]) {
  return options[options.length - 1] ?? '2串1'
}

/** 该玩法最多能串几关（2 串 1 到 N 串 1 的 N）。 */
export function getMaxParlayLegs(poolType: MatchPoolType) {
  return getPassTypeOptions(poolType).length + 1
}

export type AutoPick = {
  matchId: number
  optionKey: string
  optionLabel: string
  odd: number
  /** 赔率隐含概率，只用来排序，不是真实胜率 */
  probability: number
}

/**
 * 一键串关：每场挑出最可能命中的选项（赔率最低的那一注），
 * 再按命中概率排序，取到该玩法的关卡上限。
 *
 * 只是把"选哪几场、选哪一注"的机械活干完，不替代分析和人的判断。
 */
export function buildAutoParlayPicks(items: MatchCard[], poolType: MatchPoolType): AutoPick[] {
  const maxLegs = getMaxParlayLegs(poolType)
  const candidates: AutoPick[] = []

  for (const item of items) {
    let best: AutoPick | null = null

    for (const option of flattenOptionGroups(item)) {
      const odd = Number(option.value)
      if (!Number.isFinite(odd) || odd <= 1) {
        continue
      }
      if (!best || odd < best.odd) {
        best = {
          matchId: item.id,
          optionKey: option.key,
          optionLabel: formatPlanOptionLabel(poolType, option, item),
          odd,
          probability: 1 / odd,
        }
      }
    }

    if (best) {
      candidates.push(best)
    }
  }

  candidates.sort((left, right) => right.probability - left.probability)
  return candidates.slice(0, maxLegs)
}

export function getMaxPassTypeByCount(options: string[], selectedCount: number) {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    const option = options[index]
    if (getPassNeed(option) <= selectedCount) {
      return option
    }
  }
  return undefined
}

export function formatPassType(passType: string) {
  return `过${getPassNeed(passType)}关`
}

export function formatPassSummaryType(passType: string) {
  return `${getPassNeed(passType)}关`
}

export function getPassNeed(passType: string) {
  return Number(passType.split('串')[0]) || 0
}

/**
 * 计算"从 values 中任选 choose 个"的所有组合乘积之和。
 * 用于把每个比赛选中的选项数转换成注数。
 */
export function sumCombinationProducts(values: number[], choose: number) {
  if (choose <= 0 || values.length < choose) {
    return 0
  }

  let total = 0

  function walk(startIndex: number, depth: number, product: number) {
    if (depth === choose) {
      total += product
      return
    }

    for (let index = startIndex; index <= values.length - (choose - depth); index += 1) {
      walk(index + 1, depth + 1, product * values[index])
    }
  }

  walk(0, 0, 1)
  return total
}

/** 单注 2 元；单次中奖收入超过 10000 元按 20% 计税 */
export function getSportteryTaxInfo(amount: number): SportteryTaxInfo {
  if (amount <= 10000) {
    return {
      taxAmount: 0,
      afterTaxAmount: amount,
    }
  }

  const taxAmount = Number((amount * 0.2).toFixed(2))
  return {
    taxAmount,
    afterTaxAmount: Number((amount - taxAmount).toFixed(2)),
  }
}

export function formatMoney(amount: number) {
  return Number(amount.toFixed(2)).toString()
}

export function formatKickoffTime(text: string) {
  const [datePart, timePart = ''] = text.trim().split(/\s+/)
  if (!datePart) {
    return '-- --:--'
  }

  const shortDate = datePart.slice(5)
  const shortTime = timePart.slice(0, 5)
  return `${shortDate || '--'} ${shortTime || '--:--'}`
}

export function formatPlanOptionLabel(poolType: MatchPoolType, option: MatchCardOption, item?: MatchCard) {
  if (poolType === 'ttg') {
    return `${option.label}球`
  }

  const optionContext = findOptionContext(item, option.key)
  if (poolType === 'had' || poolType === 'mixed') {
    if (optionContext?.rowLabel === '[0]') {
      return option.label
    }
    if (optionContext?.rowLabel) {
      return `让球${option.label}`
    }
  }

  if (poolType === 'mixed' && optionContext?.sectionTitle) {
    const label =
      optionContext.sectionTitle === '总进球' ? `${option.label}球` : option.label
    return `${optionContext.sectionTitle} ${label}`
  }

  return option.label
}

export function flattenOptionGroups(item: MatchCard) {
  const baseOptions = (item.optionGroups ?? []).flatMap((group) => group.options)
  const mixedOptions = (item.mixedSections ?? []).flatMap((section) =>
    section.groups.flatMap((group) => group.options),
  )
  return [...baseOptions, ...mixedOptions]
}

function findOptionContext(item: MatchCard | undefined, optionKey: string) {
  for (const group of item?.optionGroups ?? []) {
    if (group.options.some((candidate) => candidate.key === optionKey)) {
      return { rowLabel: group.rowLabel, sectionTitle: undefined as string | undefined }
    }
  }

  for (const section of item?.mixedSections ?? []) {
    for (const group of section.groups) {
      if (group.options.some((candidate) => candidate.key === optionKey)) {
        return { rowLabel: group.rowLabel, sectionTitle: section.title }
      }
    }
  }

  return undefined
}
