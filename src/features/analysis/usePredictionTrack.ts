import { useEffect, useRef, useState } from 'react'

import { getPredictionTrack } from '../../api'
import type { PredictionTrackResponse } from '../../domain/predictionTrack'

/**
 * 取当前这一页开奖对应的逐期归档。
 *
 * 只带 30 个期号，响应约 10–20 KB（gzip 后更小）；
 * 同一页翻回来时直接命中内存缓存，不再打接口。
 *
 * 归档加载失败不阻塞走势：面板继续显示，只是没有参考框和命中标记。
 */

type PredictionTrackState = {
  loading: boolean
  error: string
  data: PredictionTrackResponse | null
}

const PAGE_CACHE_LIMIT = 24
const pageCache = new Map<string, PredictionTrackResponse>()
const inflight = new Map<string, Promise<PredictionTrackResponse>>()

export function usePredictionTrack(game: string, issues: string[], enabled = true) {
  const key = enabled && issues.length > 0 ? `${game}|${issues.join(',')}` : ''
  const keyRef = useRef(key)
  const [state, setState] = useState<PredictionTrackState>({
    loading: Boolean(key),
    error: '',
    data: key ? (pageCache.get(key) ?? null) : null,
  })

  useEffect(() => {
    keyRef.current = key

    if (!key) {
      setState({ loading: false, error: '', data: null })
      return
    }

    const cached = pageCache.get(key)
    if (cached) {
      setState({ loading: false, error: '', data: cached })
      return
    }

    let promise = inflight.get(key)
    if (!promise) {
      promise = getPredictionTrack({ game, issues })
      inflight.set(key, promise)
      promise
        .then((data) => {
          writeCache(key, data)
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
          error: error instanceof Error ? error.message : '逐期归档加载失败',
          data: prev.data,
        }))
      })

    return () => {
      active = false
    }
  }, [key, game])

  return state
}

function writeCache(key: string, data: PredictionTrackResponse) {
  pageCache.set(key, data)
  while (pageCache.size > PAGE_CACHE_LIMIT) {
    const oldest = pageCache.keys().next().value
    if (!oldest) {
      break
    }
    pageCache.delete(oldest)
  }
}
