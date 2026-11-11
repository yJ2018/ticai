import { apiUrl } from './base'
import { request } from './httpClient'
import type { RecommendationHitResponse } from '../domain/recommendationHits'

/**
 * 号码池型推荐命中记录（大乐透 / 双色球 / 快乐8）。
 *
 * 走势页只取最近 N 期与汇总，不一次拉全量；
 * 首次访问时服务端可能回填 300 期（约 3–5s），所以超时放宽到 30s。
 */

type ApiEnvelope<T> = {
  success: boolean
  data?: T
  errorMessage?: string
}

export type RecommendationHitsQuery = {
  /** dlt / ssq / kl8 */
  game: string
  issues?: string[]
  limit?: number
}

export async function getRecommendationHits(
  params: RecommendationHitsQuery,
  options: { signal?: AbortSignal } = {},
): Promise<RecommendationHitResponse> {
  const query = new URLSearchParams({ game: params.game })
  if (params.issues && params.issues.length > 0) {
    query.set('issues', params.issues.join(','))
  }
  if (params.limit) {
    query.set('limit', String(params.limit))
  }

  const body = await request<ApiEnvelope<RecommendationHitResponse>>(
    apiUrl(`/api/analysis/lottery/hits?${query.toString()}`),
    { signal: options.signal, timeoutMs: 30_000 },
  )

  if (!body.success || !body.data) {
    throw new Error(body.errorMessage || '推荐命中接口返回失败')
  }

  return body.data
}
