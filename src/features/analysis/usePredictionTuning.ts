import { useEffect, useState } from 'react'

import { getLotteryAnalysis } from '../../api'
import {
  predictionWeightsToPercent,
  type HistoryPredictionAnalysis,
  type PredictionScoreWeights,
} from '../../domain/analysisTypes'

/**
 * 「自定义权重」时的服务端重算通道。
 *
 * 以前是下载全量开奖（约 45 KB gzip）在 Worker 里算，前端必须同时维护一份 TS 算法，
 * 和服务端必然慢慢漂移。现在权重作为参数发给服务端：`?w=34-20-22-14-10`，
 * 每个参数组合各存一条快照（同一组合重复请求直接命中），前端不再持有任何算法。
 *
 * 滑块是连续值，这里做 400ms 防抖 + AbortController：拖动过程中只发最后一次。
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
  const weightKey = predictionWeightsToPercent(weights).join('-')

  useEffect(() => {
    if (!enabled) {
      setState(INITIAL)
      return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setState((prev) => ({ ...prev, loading: true, error: '' }))
      void getLotteryAnalysis(
        {
          game,
          kind: 'prediction',
          order,
          weights: weightKey.split('-').map(Number),
        },
        { signal: controller.signal },
      )
        .then((snapshot) => {
          if (controller.signal.aborted) {
            return
          }
          setState({ analysis: snapshot.analysis, loading: false, error: '' })
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return
          }
          setState({
            analysis: null,
            loading: false,
            error: error instanceof Error ? error.message : '自定义权重重算失败，请稍后重试',
          })
        })
    }, 400)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [enabled, game, order, weightKey])

  return state
}
