import { useCallback, useRef, useState } from 'react'

import { fetchRecommendations, type RecommendResponse } from '../../api/recommendApi'
import { ApiError } from '../../api/httpClient'
import { type MatchCard, type MatchPoolType } from '../../service/matchService'
import { toRecommendPool } from './recommendation'

/**
 * 一键推荐：**全部在服务端算**（apps/api/src/recommend/）。
 *
 * 前端不再用赔率反推 λ 再自比——那等于用同一份赔率跟自己打，必然在拟合噪声处
 * 冒出一个「正向优势」，然后把 22.00 的冷门串进 8 串 1。这里只发一个 GET，
 * 拿回服务端算好的方案、每条腿的理由、过滤统计与回测摘要。
 */

export type AutoParlayScope = 'today' | 'all'

export type AutoParlayState = {
  /** null = 面板关闭 */
  poolType: MatchPoolType | null
  running: boolean
  scope: AutoParlayScope
  data: RecommendResponse | null
  error: string
}

const INITIAL: AutoParlayState = {
  poolType: null,
  running: false,
  scope: 'today',
  data: null,
  error: '',
}

export function useAutoParlay() {
  const [state, setState] = useState<AutoParlayState>(INITIAL)
  const runToken = useRef(0)
  const lastRun = useRef<{ poolType: MatchPoolType; scope: AutoParlayScope } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const close = useCallback(() => {
    runToken.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    lastRun.current = null
    setState(INITIAL)
  }, [])

  const run = useCallback(async (poolType: MatchPoolType, scope: AutoParlayScope) => {
    const token = runToken.current + 1
    runToken.current = token
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    lastRun.current = { poolType, scope }

    setState({ poolType, running: true, scope, data: null, error: '' })
    try {
      const data = await fetchRecommendations(toRecommendPool(poolType), scope, controller.signal)
      if (runToken.current !== token) {
        return
      }
      setState({ poolType, running: false, scope, data, error: '' })
    } catch (error) {
      if (runToken.current !== token || controller.signal.aborted) {
        return
      }
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error && error.message
            ? error.message
            : '推荐服务暂时不可用'
      setState({ poolType, running: false, scope, data: null, error: message })
    }
  }, [])

  /** cards 只为保持调用形状（服务端自己读库），真正参与计算的是玩法与范围。 */
  const start = useCallback(
    (_cards: MatchCard[], poolType: MatchPoolType, scope: AutoParlayScope = 'today') => {
      void run(poolType, scope)
    },
    [run],
  )

  const restart = useCallback(
    (scope: AutoParlayScope) => {
      const last = lastRun.current
      if (!last) {
        return
      }
      void run(last.poolType, scope)
    },
    [run],
  )

  return { state, start, restart, close }
}
