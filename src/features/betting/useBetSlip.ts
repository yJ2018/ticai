import { useEffect, useMemo, useState } from 'react'
import { type MatchCard, type MatchCardOption, type MatchPoolType } from '../../service/matchService'
import {
  flattenOptionGroups,
  formatKickoffTime,
  formatPassSummaryType,
  formatPlanOptionLabel,
  getMaxPassTypeByCount,
  getMaxPassTypeFromOptions,
  getPassNeed,
  getPassTypeOptions,
  sumCombinationProducts,
  type AutoPick,
  type PlanEntry,
} from './betSlipMath'

export type BetSlip = {
  selectedOptionKeys: Record<number, string[]>
  expandedMixedIds: number[]
  toggleOption: (matchId: number, optionKey: string) => void
  toggleMixedExpand: (matchId: number) => void
  selectedCount: number
  passTypeOptions: string[]
  selectedPassTypes: string[]
  hasManualPassSelection: boolean
  togglePassType: (passType: string) => void
  totalUnits: number
  passSummaryText: string
  planEntries: PlanEntry[]
  betAmount: number
  maxBonus: number
  multiple: number
  setMultiple: (value: number) => void
  applyAutoPicks: (picks: AutoPick[]) => void
  reset: () => void
}

type SelectedOptionEntry = {
  item: MatchCard
  selectedOptions: MatchCardOption[]
}

/**
 * 投注单状态与金额计算。
 * 从 HomePage 抽离，页面只负责渲染与弹层编排。
 */
export function useBetSlip(items: MatchCard[], activePool: MatchPoolType): BetSlip {
  const [selectedOptionKeys, setSelectedOptionKeys] = useState<Record<number, string[]>>({})
  const [expandedMixedIds, setExpandedMixedIds] = useState<number[]>([])
  const [manualPassTypes, setManualPassTypes] = useState<string[]>([])
  const [hasManualPassSelection, setHasManualPassSelection] = useState(false)
  const [multiple, setMultiple] = useState(1)

  // 切换玩法池时清空选择
  useEffect(() => {
    setSelectedOptionKeys({})
    setExpandedMixedIds([])
  }, [activePool])

  const selectedOptionEntries: SelectedOptionEntry[] = useMemo(
    () =>
      items
        .map((item) => {
          const selectedKeys = selectedOptionKeys[item.id] ?? []
          const selectedOptions = flattenOptionGroups(item).filter((option) =>
            selectedKeys.includes(option.key),
          )
          if (selectedOptions.length === 0) {
            return undefined
          }
          return { item, selectedOptions }
        })
        .filter((entry): entry is SelectedOptionEntry => Boolean(entry)),
    [items, selectedOptionKeys],
  )

  const passTypeOptions = useMemo(() => getPassTypeOptions(activePool), [activePool])

  const selectedMatchMetrics = useMemo(
    () =>
      selectedOptionEntries.map((entry) => ({
        optionCount: entry.selectedOptions.length,
        maxOdd: entry.selectedOptions.reduce((max, option) => Math.max(max, Number(option.value) || 0), 0),
      })),
    [selectedOptionEntries],
  )

  const selectedCount = selectedMatchMetrics.length
  const currentMaxPassType =
    getMaxPassTypeByCount(passTypeOptions, selectedCount) ?? getMaxPassTypeFromOptions(passTypeOptions)

  const selectedPassTypes = useMemo(() => {
    if (!hasManualPassSelection) {
      return currentMaxPassType ? [currentMaxPassType] : []
    }

    const legalManual = manualPassTypes.filter(
      (passType) => passTypeOptions.includes(passType) && getPassNeed(passType) <= selectedCount,
    )
    const merged = new Set<string>(legalManual)
    if (currentMaxPassType) {
      merged.add(currentMaxPassType)
    }

    return Array.from(merged).sort((a, b) => getPassNeed(a) - getPassNeed(b))
  }, [currentMaxPassType, hasManualPassSelection, manualPassTypes, passTypeOptions, selectedCount])

  const totalUnits = selectedPassTypes.reduce((sum, passType) => {
    const passNeed = getPassNeed(passType)
    if (passNeed < 2 || selectedCount < passNeed) {
      return sum
    }
    return sum + sumCombinationProducts(selectedMatchMetrics.map((item) => item.optionCount), passNeed)
  }, 0)

  const passSummaryText = selectedPassTypes
    .slice()
    .sort((a, b) => getPassNeed(a) - getPassNeed(b))
    .map((passType) => formatPassSummaryType(passType))
    .join('、')

  const planEntries = useMemo<PlanEntry[]>(
    () =>
      selectedOptionEntries.map((entry, index) => ({
        id: entry.item.id,
        order: index + 1,
        matchNo: entry.item.matchNo || '周?000',
        teams: entry.item.title,
        kickoffTime: formatKickoffTime(entry.item.time),
        selectedOptions: entry.selectedOptions.map((option) => ({
          key: option.key,
          label: formatPlanOptionLabel(activePool, option, entry.item),
          value: option.value,
        })),
      })),
    [activePool, selectedOptionEntries],
  )

  const betAmount = totalUnits * 2 * multiple
  const maxBonus = Number(
    (
      selectedPassTypes.reduce((sum, passType) => {
        const passNeed = getPassNeed(passType)
        if (passNeed < 2 || selectedCount < passNeed) {
          return sum
        }
        return sum + sumCombinationProducts(selectedMatchMetrics.map((item) => item.maxOdd), passNeed)
      }, 0) *
      2 *
      multiple
    ).toFixed(2),
  )

  // 已选场次变少时，自动剔除不再合法的过关方式
  useEffect(() => {
    const legalManual = manualPassTypes.filter(
      (passType) => passTypeOptions.includes(passType) && getPassNeed(passType) <= selectedCount,
    )
    if (legalManual.length === manualPassTypes.length) {
      return
    }
    setManualPassTypes(legalManual)
  }, [manualPassTypes, passTypeOptions, selectedCount])

  function toggleOption(matchId: number, optionKey: string) {
    setSelectedOptionKeys((prev) => {
      const current = prev[matchId] ?? []
      const next = current.includes(optionKey)
        ? current.filter((item) => item !== optionKey)
        : [...current, optionKey]

      if (next.length === 0) {
        const { [matchId]: _, ...rest } = prev
        return rest
      }

      return {
        ...prev,
        [matchId]: next,
      }
    })
  }

  function toggleMixedExpand(matchId: number) {
    setExpandedMixedIds((prev) =>
      prev.includes(matchId) ? prev.filter((id) => id !== matchId) : [...prev, matchId],
    )
  }

  function togglePassType(passType: string) {
    if (getPassNeed(passType) > selectedCount) {
      return
    }
    setHasManualPassSelection(true)
    setManualPassTypes((prev) =>
      prev.includes(passType) ? prev.filter((item) => item !== passType) : [...prev, passType],
    )
  }

  function reset() {
    setSelectedOptionKeys({})
    setExpandedMixedIds([])
    setMultiple(1)
    setManualPassTypes([])
    setHasManualPassSelection(false)
  }

  /** 一键串关：整份替换选择，并回到"自动取最大过关"的状态。 */
  function applyAutoPicks(picks: AutoPick[]) {
    const next: Record<number, string[]> = {}
    for (const pick of picks) {
      next[pick.matchId] = [pick.optionKey]
    }
    setSelectedOptionKeys(next)
    setManualPassTypes([])
    setHasManualPassSelection(false)
  }

  return {
    selectedOptionKeys,
    expandedMixedIds,
    toggleOption,
    toggleMixedExpand,
    selectedCount,
    passTypeOptions,
    selectedPassTypes,
    hasManualPassSelection,
    togglePassType,
    totalUnits,
    passSummaryText,
    planEntries,
    betAmount,
    maxBonus,
    multiple,
    setMultiple,
    applyAutoPicks,
    reset,
  }
}
