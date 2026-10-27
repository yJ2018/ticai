import { useEffect, useRef, useState } from 'react'

import {
  analyzeHistoryPrediction,
  type HistoryPredictionAnalysis,
  type PredictionHistoryEntry,
  type PredictionScoreWeights,
} from '../../domain/historyPrediction'
import { historyService } from '../../service/historyService'

/**
 * 「自定义权重」时的本地重算通道。
 *
 * 服务端只预算固定参数（马尔可夫阶数 1–5）；权重是 0–100% 的连续值，
 * 组合无穷，只能下载全量号码（紧凑接口，约 45 KB gzip）在 Worker 里算。
 * 这是唯一还需要前端的计算路径，且只在用户真的拖了滑块时才走。
 */

type TuningState = {
  analysis: HistoryPredictionAnalysis | null
  loading: boolean
  error: string
}

const INITIAL: TuningState = { analysis: null, loading: false, error: '' }

export function usePredictionTuning({
  enabled,
  order,
  weights,
  game = 'pl5',
}: {
  enabled: boolean
  order: number
  weights: PredictionScoreWeights
  game?: 'pl5' | 'qxc'
}) {
  const [state, setState] = useState<TuningState>(INITIAL)
  const entriesRef = useRef<PredictionHistoryEntry[] | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    const worker = new Worker(new URL('../../workers/historyAnalysisWorker.ts', import.meta.url), {
      type: 'module',
    })
    workerRef.current = worker

    worker.onmessage = (
      event: MessageEvent<{ requestId: number; analysis: HistoryPredictionAnalysis }>,
    ) => {
      if (event.data.requestId !== requestIdRef.current) {
        return
      }
      setState({ analysis: event.data.analysis, loading: false, error: '' })
    }

    worker.onerror = () => {
      setState((prev) => ({ ...prev, loading: false, error: '本地重算失败，请重试' }))
    }

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      return
    }

    let alive = true
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setState((prev) => ({ ...prev, loading: true, error: '' }))

    void (async () => {
      try {
        if (!entriesRef.current) {
          entriesRef.current = await historyService.getBulkAnalysisEntries(game)
        }
        const entries = entriesRef.current
        if (!alive || !entries) {
          return
        }

        const worker = workerRef.current
        if (!worker) {
          const analysis = analyzeHistoryPrediction(entries, {
            markovOrder: order,
            scoreWeights: weights,
          })
          if (alive && requestId === requestIdRef.current) {
            setState({ analysis, loading: false, error: '' })
          }
          return
        }

        worker.postMessage({ requestId, entries, options: { markovOrder: order, scoreWeights: weights } })
      } catch (error) {
        if (alive) {
          setState((prev) => ({
            ...prev,
            loading: false,
            error: error instanceof Error ? error.message : '全量开奖加载失败，无法本地调参',
          }))
        }
      }
    })()

    return () => {
      alive = false
    }
  }, [enabled, game, order, weights])

  return state
}
