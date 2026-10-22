import { type MatchPoolType } from '../../service/matchService'
import { type PlanEntry } from './betSlipMath'

/**
 * 串关分析只保留「前端需要的部分」：
 * - 缓存 key（同一组选择复用 3 小时内的结果）
 * - 结果解析（整体风险 / 综合信心 / 一句话总结）
 *
 * 提示词与赔率拼装已下沉到服务端（apps/api/src/ai/parlay-prompt.mjs）。
 */

export type CachedLegAnalysis = {
  id: number
  content: string
  savedAt: number
}

export type ParlayAnalysisInput = {
  pool: MatchPoolType
  passSummaryText: string
  entries: PlanEntry[]
  matches: unknown[]
  betAmount: number
  maxBonus: number
  /** 3 小时内已分析过的单场结论，用于批量分析时复用 */
  cachedLegAnalyses?: CachedLegAnalysis[]
}

export function buildParlayAnalysisKey(input: ParlayAnalysisInput) {
  const legs = input.entries.map((entry) => {
    const options = entry.selectedOptions
      .map((option) => `${option.key}:${option.value}`)
      .join(',')
    return `${entry.id}[${options}]`
  })

  return `${input.pool}:${input.passSummaryText}:${legs.join('|')}`
}

export type ParlayAnalysisSummary = {
  risk: string
  confidence: string
  verdict: string
}

/** 从串关分析输出里提取整体风险、综合信心和一句话总结。 */
export function parseParlaySummary(content: string): ParlayAnalysisSummary | null {
  if (!content) {
    return null
  }

  const normalized = content.replace(/\*\*/g, '').replace(/^#{1,6}\s*/gm, '')
  const risk = normalized.match(/整体风险[：:]\s*(低|中|高)/)?.[1] ?? ''
  const confidence = normalized.match(/综合信心[：:]\s*(高|中|低)/)?.[1] ?? ''
  const verdict = normalized.match(/一句话总结[：:]\s*([^\n]+)/)?.[1]?.trim() ?? ''

  if (!risk && !confidence) {
    return null
  }

  return { risk, confidence, verdict }
}
