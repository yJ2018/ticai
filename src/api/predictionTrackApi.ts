import { apiUrl } from './base'
import { request } from './httpClient'
import type { PredictionTrackResponse } from '../domain/predictionTrack'

/**
 * 逐期参考归档：每期开奖前给出的参考 + 开奖后的逐位命中。
 *
 * 走势页只把当前这一页的 30 个期号带上来，避免一次拉全量；
 * 全量命中率 / 偏差矩阵由服务端在归档时算好（summary），一起返回。
 */

type ApiEnvelope<T> = {
  success: boolean
  data?: T
  errorMessage?: string
}

export type PredictionTrackQuery = {
  /** pl5 / qxc，也接受体彩 gameNo */
  game: string
  /** 当前页显示的期号；不传则由服务端返回最近 limit 期 */
  issues?: string[]
  limit?: number
}

export async function getPredictionTrack(
  params: PredictionTrackQuery,
  options: { signal?: AbortSignal } = {},
): Promise<PredictionTrackResponse> {
  const query = new URLSearchParams({ game: params.game })
  if (params.issues && params.issues.length > 0) {
    query.set('issues', params.issues.join(','))
  }
  if (params.limit) {
    query.set('limit', String(params.limit))
  }

  const body = await request<ApiEnvelope<PredictionTrackResponse>>(
    apiUrl(`/api/analysis/lottery/track?${query.toString()}`),
    {
      signal: options.signal,
      // 首次访问时服务端可能现算一次全量归档（远库写 7700 行约 10–15s），
      // 默认 15s 会正好卡在边界上；归档存在后这个超时不会被用到。
      timeoutMs: 30_000,
    },
  )

  if (!body.success || !body.data) {
    throw new Error(body.errorMessage || '逐期归档接口返回失败')
  }

  return body.data
}
