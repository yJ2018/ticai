import { type MatchCard, type MatchPoolType } from '../../service/matchService'

/**
 * 前端只保留"展示用"的赔率格式化与结果解析。
 *
 * 单场分析的系统提示词、官方数据拼装已经整体搬到服务端
 * （apps/api/src/ai/prompt.mjs）——提示词改版不再需要前端发版，
 * 也不用把一整场数据塞进请求体。
 */

export const POOL_LABELS: Record<MatchPoolType, string> = {
  had: '胜平负',
  crs: '比分',
  ttg: '总进球数',
  hafu: '半全场',
  mixed: '混合过关',
}

/**
 * 把当前玩法的完整赔率拼成一段文本。只给 AI 摘要会丢掉大部分比分/半全场选项，
 * 因此优先使用 optionGroups 里的全部可选项，超长时再截断。
 *
 * 目前给"方案级 AI 分析"（parlayAiAnalysis）使用；单场分析已改由服务端取数。
 */
export function formatOddsForPrompt(match: MatchCard, pool: MatchPoolType) {
  const groups =
    pool === 'mixed'
      ? [
          ...(match.optionGroups ?? []),
          ...(match.mixedSections ?? []).flatMap((section) => section.groups),
        ]
      : (match.optionGroups ?? [])

  const parts: string[] = []

  for (const group of groups) {
    const options = group.options
      .filter((option) => option.value && option.value !== '--')
      .map((option) => `${option.label}:${option.value}`)

    if (options.length === 0) {
      continue
    }

    parts.push(`${group.rowLabel ? `${group.rowLabel} ` : ''}${options.join(' / ')}`)
  }

  return parts.join('；') || match.oddsSummary || '暂无'
}

export type AnalysisSummary = {
  recommendation: string
  confidence: string
  score: string
}

/**
 * 从模型输出里提取「推荐 / 信心 / 比分」，失败时返回 null。
 * 模型偶尔会用 Markdown 加粗，这里先做一次轻量清洗。
 */
export function parseAnalysisSummary(content: string): AnalysisSummary | null {
  if (!content) {
    return null
  }

  const normalized = content.replace(/\*\*/g, '').replace(/^#{1,6}\s*/gm, '')
  const recommendation = normalized.match(/推荐选项[：:]\s*([^\n]+)/)?.[1]?.trim() ?? ''
  const confidence = normalized.match(/信心等级[：:]\s*(高|中|低)/)?.[1] ?? ''
  const score = normalized.match(/比分参考[：:]\s*([^\n]+)/)?.[1]?.trim() ?? ''

  if (!recommendation && !confidence) {
    return null
  }

  return { recommendation, confidence, score }
}
