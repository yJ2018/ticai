import { useCallback, useEffect, useRef, useState } from 'react'
import { askAiStream, type AiStreamDone } from '../../api/aiApi'
import { getVenueWeather } from '../../api/venueWeatherApi'
import { type MatchCard, type MatchPoolType } from '../../service/matchService'
import {
  buildMatchAnalysisMessages,
  parseAnalysisSummary,
  type AnalysisSummary,
} from './aiAnalysis'
import {
  buildMatchAiCacheKey,
  readAiAnalysisCache,
  removeAiAnalysisCache,
  writeAiAnalysisCache,
  type MatchAiCachePayload,
} from './aiAnalysisCache'

export type AiAnalysisStatus = 'loading' | 'streaming' | 'done' | 'error'

export type AiAnalysisState = {
  key: string
  match: MatchCard
  pool: MatchPoolType
  status: AiAnalysisStatus
  reasoning: string
  content: string
  error: string
  summary: AnalysisSummary | null
  weatherLabel: string
  elapsedMs?: number
  usage?: AiStreamDone['usage']
  /** 本次结果是否直接来自 3 小时内的 localStorage 缓存 */
  fromCache?: boolean
}

/**
 * 单场比赛的 AI 分析状态机：
 * - 同一玩法 + 比赛的结果会写入 localStorage，3 小时内重复打开直接展示；
 * - 打开新比赛会中止上一条流；
 * - 比赛地天气按球队缓存 10 分钟（BFF 内部还会缓存天气与城市解析）。
 */
export function useMatchAiAnalysis(activePool: MatchPoolType) {
  const [analysis, setAnalysis] = useState<AiAnalysisState | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const stateRef = useRef<AiAnalysisState | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => () => controllerRef.current?.abort(), [])

  function applyAnalysis(next: AiAnalysisState | null) {
    stateRef.current = next
    setAnalysis(next)
  }

  function getVenueWeatherFor(match: MatchCard, signal: AbortSignal) {
    const team = match.homeTeam || ''
    if (!team) {
      return Promise.resolve(null)
    }

    return getVenueWeather(
      {
        teamId: match.homeTeamId,
        homeTeam: team,
        league: match.subtitle || '',
        kickoff: match.time || '',
      },
      signal,
    ).catch(() => null)
  }

  function update(
    key: string,
    patch: Partial<AiAnalysisState> | ((prev: AiAnalysisState) => Partial<AiAnalysisState>),
  ) {
    const current = stateRef.current
    if (!current || current.key !== key) {
      return
    }
    const nextPatch = typeof patch === 'function' ? patch(current) : patch
    const next = { ...current, ...nextPatch }
    stateRef.current = next
    setAnalysis(next)
  }

  async function run(base: AiAnalysisState) {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller

    // 天气只是增强信息，最多等 15s，避免整个分析卡在「获取天气」阶段
    const weatherController = new AbortController()
    const weatherTimer = window.setTimeout(() => weatherController.abort(), 15_000)
    const weatherSignal =
      typeof AbortSignal.any === 'function'
        ? AbortSignal.any([controller.signal, weatherController.signal])
        : controller.signal

    let venueWeather = null
    try {
      venueWeather = await getVenueWeatherFor(base.match, weatherSignal)
    } finally {
      window.clearTimeout(weatherTimer)
    }

    if (controller.signal.aborted) {
      return
    }

    const weatherLabel =
      venueWeather?.available === true
        ? `${venueWeather.city} ${
            venueWeather.current.temperature !== null
              ? `${venueWeather.current.temperature}℃ `
              : ''
          }${venueWeather.current.weather}`
        : '比赛地天气未获取'

    update(base.key, { status: 'streaming', weatherLabel })

    try {
      const done = await askAiStream(
        {
          messages: buildMatchAnalysisMessages({
            match: base.match,
            pool: base.pool,
            venueWeather,
          }),
          thinking: false,
          maxTokens: 1_500,
          temperature: 0.4,
          signal: controller.signal,
        },
        {
          onReasoning: (delta) => {
            update(base.key, (prev) => ({ reasoning: prev.reasoning + delta }))
          },
          onContent: (delta) => {
            update(base.key, (prev) => ({ content: prev.content + delta }))
          },
        },
      )

      if (controller.signal.aborted) {
        return
      }

      const current = stateRef.current
      if (!current || current.key !== base.key) {
        return
      }

      if (!current.content.trim()) {
        update(base.key, {
          status: 'error',
          summary: null,
          error: done.truncated
            ? '模型输出达到长度上限被截断，请重试'
            : '模型没有返回分析结果，请重试',
          elapsedMs: done.elapsedMs,
          usage: done.usage,
        })
        return
      }

      const summary = parseAnalysisSummary(current.content)
      const next: AiAnalysisState = {
        ...current,
        status: 'done',
        summary,
        elapsedMs: done.elapsedMs,
        usage: done.usage,
        fromCache: false,
      }
      stateRef.current = next
      writeAiAnalysisCache<MatchAiCachePayload>(
        buildMatchAiCacheKey(base.pool, base.match.id),
        {
          content: current.content,
          summary,
          weatherLabel: current.weatherLabel,
          elapsedMs: done.elapsedMs,
          usage: done.usage,
        },
      )
      setAnalysis(next)
    } catch (error) {
      if (controller.signal.aborted) {
        return
      }
      update(base.key, {
        status: 'error',
        error: error instanceof Error ? error.message : 'AI 分析失败，请重试',
      })
    }
  }

  const open = useCallback(
    (match: MatchCard, element: HTMLElement) => {
      const key = `${activePool}:${match.id}`
      setAnchor(element)

      const base: AiAnalysisState = {
        key,
        match,
        pool: activePool,
        status: 'loading',
        reasoning: '',
        content: '',
        error: '',
        summary: null,
        weatherLabel: '',
      }

      const cached = readAiAnalysisCache<MatchAiCachePayload>(
        buildMatchAiCacheKey(activePool, match.id),
      )
      if (cached) {
        controllerRef.current?.abort()
        applyAnalysis({
          ...base,
          status: 'done',
          content: cached.payload.content,
          summary: cached.payload.summary,
          weatherLabel: cached.payload.weatherLabel,
          elapsedMs: cached.payload.elapsedMs,
          usage: cached.payload.usage,
          fromCache: true,
        })
        return
      }

      applyAnalysis(base)
      void run(base)
    },
    // run 只依赖 ref 与 setState，不需要进入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activePool],
  )

  const retry = useCallback(() => {
    if (!analysis) {
      return
    }
    removeAiAnalysisCache(buildMatchAiCacheKey(analysis.pool, analysis.match.id))
    const base: AiAnalysisState = {
      ...analysis,
      status: 'loading',
      reasoning: '',
      content: '',
      error: '',
      summary: null,
      elapsedMs: undefined,
      usage: undefined,
      fromCache: false,
    }
    applyAnalysis(base)
    void run(base)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis])

  const close = useCallback(() => {
    controllerRef.current?.abort()
    applyAnalysis(null)
    setAnchor(null)
  }, [])

  return { analysis, anchor, open, retry, close }
}
