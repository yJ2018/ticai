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

/**
 * 竞彩单注奖金限额（元），按过关场次：
 * 单场 10 万；2/3 串 20 万；4/5 串 50 万；6 串及以上 100 万。
 * 倍数按「多注」处理：每一注各自封顶，所以总额 = 单注封顶 × 倍数。
 */
export function getPassTypePayoutLimit(passType: string) {
  const need = getPassNeed(passType)
  if (need >= 6) {
    return 1_000_000
  }
  if (need >= 4) {
    return 500_000
  }
  if (need >= 2) {
    return 200_000
  }
  return 100_000
}

export const PAYOUT_LIMIT_RULE = '竞彩单注奖金限额：单场 10 万、2/3 串 20 万、4/5 串 50 万、6 串以上 100 万'

/**
 * 理论最高奖金：每个过关组合算一注（2 元），单注按对应限额封顶后再乘倍数。
 */
export function sumCappedCombinationPayouts(values: number[], choose: number, limit: number, multiple: number) {
  if (choose <= 0 || values.length < choose) {
    return 0
  }

  let total = 0

  function walk(startIndex: number, depth: number, product: number) {
    if (depth === choose) {
      total += Math.min(product * 2, limit) * multiple
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
