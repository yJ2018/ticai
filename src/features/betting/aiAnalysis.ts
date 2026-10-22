import { type MatchPoolType } from '../../service/matchService'

/**
 * 前端只保留展示用的玩法名与结果解析。
 *
 * 单场/串关的系统提示词、赔率与官方数据拼装都已经搬到服务端
 * （apps/api/src/ai/prompt.mjs 与 parlay-prompt.mjs），提示词改版不需要前端发版。
 */

export const POOL_LABELS: Record<MatchPoolType, string> = {
  had: '胜平负',
  crs: '比分',
  ttg: '总进球数',
  hafu: '半全场',
  mixed: '混合过关',
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
