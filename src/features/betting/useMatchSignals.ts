import { useEffect, useRef, useState } from 'react'

import { fetchMatchSignals, type MatchSignal, type SignalPool } from '../../api/matchSignalsApi'
import { type MatchPoolType } from '../../service/matchService'

/**
 * 投注页的「赔率接近」标注。
 *
 * 只在有模型覆盖的玩法（胜平负 / 进球数 / 混合）拉取；比分、半全场没有概率模型，
 * 不硬标。数据随盘口刷新（`dataAsOf` 变化）重新获取，失败就静默不标，不影响投注。
 */

export type MatchSignalMap = Record<string, MatchSignal>

function requestPoolFor(poolType: MatchPoolType): SignalPool | null {
  if (poolType === 'had' || poolType === 'ttg' || poolType === 'mixed') {
    return poolType
  }
  return null
}

export function useMatchSignals(poolType: MatchPoolType, dataAsOf: string | null) {
  const [signals, setSignals] = useState<MatchSignalMap>({})
  const abortRef = useRef<AbortController | null>(null)
  const lastPoolRef = useRef<SignalPool | null>(null)

  useEffect(() => {
    const requestPool = requestPoolFor(poolType)
    abortRef.current?.abort()
    abortRef.current = null

    // 换玩法先清空，避免上一个玩法的标注在下一屏闪一下
    if (lastPoolRef.current !== requestPool) {
      lastPoolRef.current = requestPool
      setSignals({})
    }

    if (!requestPool) {
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    let cancelled = false

    void fetchMatchSignals(requestPool, controller.signal)
      .then((data) => {
        if (cancelled || controller.signal.aborted) {
          return
        }
        const map: MatchSignalMap = {}
        for (const signal of data.signals) {
          map[`${signal.matchId}:${signal.pool}`] = signal
        }
        setSignals(map)
      })
      .catch(() => {
        // 标注是增强信息，接口失败时保持页面可用，不弹错误
        if (!cancelled && !controller.signal.aborted) {
          setSignals({})
        }
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [poolType, dataAsOf])

  return signals
}
