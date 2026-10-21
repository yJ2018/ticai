import { type AiStreamDone } from '../../api/aiApi'
import { type MatchPoolType } from '../../service/matchService'
import { type AnalysisSummary } from './aiAnalysis'
import { type ParlayAnalysisSummary } from './parlayAiAnalysis'

/** AI 结果本地缓存 3 小时，过期后重新请求。 */
export const AI_ANALYSIS_CACHE_TTL_MS = 3 * 60 * 60 * 1000

const PREFIX = 'ticai.ai-analysis.v1:'

type Cached<T> = {
  savedAt: number
  payload: T
}

export type MatchAiCachePayload = {
  content: string
  summary: AnalysisSummary | null
  weatherLabel: string
  elapsedMs?: number
  usage?: AiStreamDone['usage']
}

export type ParlayAiCachePayload = {
  content: string
  summary: ParlayAnalysisSummary | null
  elapsedMs?: number
  usage?: AiStreamDone['usage']
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** 单场缓存按「玩法 + 比赛 ID」隔离，避免不同玩法的结论互相污染。 */
export function buildMatchAiCacheKey(pool: MatchPoolType, matchId: number) {
  return `${PREFIX}match:${pool}:${matchId}`
}

/** 串关缓存按完整方案（场次 + 选项 + 过关方式）隔离。 */
export function buildParlayAiCacheKey(planKey: string) {
  return `${PREFIX}parlay:${planKey}`
}

export function readAiAnalysisCache<T>(key: string): Cached<T> | null {
  const storage = getStorage()
  if (!storage) {
    return null
  }

  try {
    const raw = storage.getItem(key)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as Partial<Cached<T>>
    if (
      typeof parsed.savedAt !== 'number' ||
      !parsed.payload ||
      Date.now() - parsed.savedAt > AI_ANALYSIS_CACHE_TTL_MS ||
      parsed.savedAt > Date.now() + 60_000
    ) {
      storage.removeItem(key)
      return null
    }
    return { savedAt: parsed.savedAt, payload: parsed.payload as T }
  } catch {
    try {
      storage.removeItem(key)
    } catch {
      // localStorage 不可用时忽略
    }
    return null
  }
}

export function writeAiAnalysisCache<T>(key: string, payload: T) {
  const storage = getStorage()
  if (!storage) {
    return
  }
  try {
    storage.setItem(key, JSON.stringify({ savedAt: Date.now(), payload }))
  } catch {
    // 配额不足或隐私模式禁用存储时忽略；本次结果仍在页面状态里可见
  }
}

export function removeAiAnalysisCache(key: string) {
  const storage = getStorage()
  if (!storage) {
    return
  }
  try {
    storage.removeItem(key)
  } catch {
    // 忽略
  }
}
