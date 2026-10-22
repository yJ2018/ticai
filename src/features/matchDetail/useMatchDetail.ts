import { useEffect, useState } from 'react'

import { getMatchDetail, type MatchDetail } from '../../api/matchDetailApi'

export type MatchDetailState = {
  detail: MatchDetail | null
  loading: boolean
  error: string
}

const INITIAL: MatchDetailState = { detail: null, loading: false, error: '' }

/**
 * 拉取单场对战详情。
 *
 * 注意 getMatchDetail 内部已经把 404/503/超时都吞成 null，
 * 所以这里的 error 只表示"这场确实没有数据"，不是接口挂了。
 */
export function useMatchDetail(matchId: number | null) {
  const [state, setState] = useState<MatchDetailState>(INITIAL)

  useEffect(() => {
    if (!matchId || !Number.isFinite(matchId)) {
      setState(INITIAL)
      return
    }

    const controller = new AbortController()
    setState({ detail: null, loading: true, error: '' })

    void getMatchDetail(matchId, controller.signal).then((detail) => {
      if (controller.signal.aborted) {
        return
      }
      setState({
        detail,
        loading: false,
        error: detail ? '' : '这场比赛暂时没有对战数据',
      })
    })

    return () => controller.abort()
  }, [matchId])

  return state
}
