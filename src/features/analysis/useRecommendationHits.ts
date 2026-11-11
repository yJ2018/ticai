import { useEffect, useRef, useState } from 'react'

import { getRecommendationHits } from '../../api'
import type { RecommendationHitResponse } from '../../domain/recommendationHits'

/**
 * 取号码池型推荐命中记录（大乐透 / 双色球 / 快乐8）。
 *
 * 只请求最近 N 期 + 汇总；同一彩种翻回时命中内存缓存。
 * 加载失败不阻塞走势：推荐卡与走势仍照常显示，只是命中记录区显示空态。
 */

type RecommendationHitsState = {
  loading: boolean
  error: string
  data: RecommendationHitResponse | null
}

const cache = new Map<string, RecommendationHitResponse>()
const inflight = new Map<string, Promise<RecommendationHitResponse>>()

export function useRecommendationHits(game: string, enabled = true, limit = 20) {
  const key = enabled ? `${game}|${limit}` : ''
  const keyRef = useRef(key)
  const [state, setState] = useState<RecommendationHitsState>({
    loading: Boolean(key),
    error: '',
    data: key ? (cache.get(key) ?? null) : null,
  })

  useEffect(() => {
    keyRef.current = key

    if (!key) {
      setState({ loading: false, error: '', data: null })
      return
    }

    const cached = cache.get(key)
    if (cached) {
      setState({ loading: false, error: '', data: cached })
      return
    }

    let promise = inflight.get(key)
    if (!promise) {
      promise = getRecommendationHits({ game, limit })
      inflight.set(key, promise)
      promise
        .then((data) => {
          cache.set(key, data)
        })
        .finally(() => {
          inflight.delete(key)
        })
    }

    setState((prev) => ({ ...prev, loading: true, error: '' }))

    let active = true
    promise
      .then((data) => {
        if (!active || keyRef.current !== key) {
          return
        }
        setState({ loading: false, error: '', data })
      })
      .catch((error) => {
        if (!active || keyRef.current !== key) {
          return
        }
        setState((prev) => ({
          loading: false,
          error: error instanceof Error ? error.message : '推荐命中记录加载失败',
          data: prev.data,
        }))
      })

    return () => {
      active = false
    }
  }, [key, game, limit])

  return state
}
