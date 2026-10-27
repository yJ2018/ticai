import { useCallback, useEffect, useRef, useState } from 'react'

import {
  getLotteryAnalysis,
  type AnalysisSnapshotKindMap,
  type LotteryAnalysisKind,
  type LotteryAnalysisSnapshot,
} from '../../api'

/**
 * 取一份服务端算好的分析快照。
 *
 * 与旧的「下载全量开奖 → Worker 里算」相比：
 *   - 只发一个请求，返回约 2 KB gzip；
 *   - 样本恒定是库里的全量（不会因为本地缓存没同步完而变少）；
 *   - 顺带拿到溯源（based on 哪一期 / 哪一天 / 多少期）与 `stale`。
 *
 * `order` 变化（马尔可夫阶数）只是换一个已预算好的快照，不会触发重算。
 */

export type AnalysisSnapshotState<T> = {
  loading: boolean
  error: string
  snapshot: LotteryAnalysisSnapshot<T> | null
}

export function useAnalysisSnapshot<K extends LotteryAnalysisKind>(
  game: string,
  kind: K,
  order?: number,
  options: { enabled?: boolean } = {},
) {
  const enabled = options.enabled !== false
  const [state, setState] = useState<AnalysisSnapshotState<AnalysisSnapshotKindMap[K]>>({
    loading: enabled,
    error: '',
    snapshot: null,
  })
  const requestIdRef = useRef(0)

  const load = useCallback(
    async (options: { signal?: AbortSignal; silent?: boolean } = {}) => {
      const requestId = requestIdRef.current + 1
      requestIdRef.current = requestId

      if (!options.silent) {
        setState((prev) => ({ ...prev, loading: true, error: '' }))
      }

      try {
        const snapshot = await getLotteryAnalysis({ game, kind, order }, { signal: options.signal })
        if (requestIdRef.current !== requestId) {
          return
        }
        setState({ loading: false, error: '', snapshot })
      } catch (error) {
        if (options.signal?.aborted || requestIdRef.current !== requestId) {
          return
        }
        setState((prev) => ({
          loading: false,
          error: error instanceof Error ? error.message : '分析加载失败，请稍后重试',
          snapshot: prev.snapshot,
        }))
      }
    },
    [game, kind, order],
  )

  useEffect(() => {
    if (!enabled) {
      setState({ loading: false, error: '', snapshot: null })
      return
    }
    const controller = new AbortController()
    void load({ signal: controller.signal })
    return () => controller.abort()
  }, [enabled, load])

  const reload = useCallback(() => {
    void load()
  }, [load])

  return { ...state, reload }
}
