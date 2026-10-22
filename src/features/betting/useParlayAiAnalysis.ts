import { useCallback, useEffect, useRef, useState } from 'react'
import { type AiStreamDone } from '../../api/aiApi'
import { askParlayAnalysis } from '../../api/parlayApi'
import {
  buildMatchAiCacheKey,
  buildParlayAiCacheKey,
  readAiAnalysisCache,
  removeAiAnalysisCache,
  writeAiAnalysisCache,
  type MatchAiCachePayload,
  type ParlayAiCachePayload,
} from './aiAnalysisCache'
import {
  buildParlayAnalysisKey,
  parseParlaySummary,
  type CachedLegAnalysis,
  type ParlayAnalysisInput,
  type ParlayAnalysisSummary,
} from './parlayAiAnalysis'

export type ParlayAiAnalysisStatus = 'loading' | 'streaming' | 'done' | 'error'

export type ParlayAiAnalysisState = {
  key: string
  input: ParlayAnalysisInput
  status: ParlayAiAnalysisStatus
  content: string
  error: string
  summary: ParlayAnalysisSummary | null
  elapsedMs?: number
  usage?: AiStreamDone['usage']
  /** 本次结果是否直接来自 3 小时内的 localStorage 缓存 */
  fromCache?: boolean
}

function attachCachedLegAnalyses(input: ParlayAnalysisInput): ParlayAnalysisInput {
  const cachedLegAnalyses = input.entries.flatMap<CachedLegAnalysis>((entry) => {
    const cached = readAiAnalysisCache<MatchAiCachePayload>(
      buildMatchAiCacheKey(input.pool, entry.id),
    )
    return cached && cached.payload.content.trim()
      ? [
          {
            id: entry.id,
            content: cached.payload.content,
            savedAt: cached.savedAt,
          },
        ]
      : []
  })

  return cachedLegAnalyses.length > 0
    ? { ...input, cachedLegAnalyses }
    : input
}

/**
 * 方案级 AI 分析状态机：
 * - 只围绕当前方案里已选的场次和选项分析；
 * - 同一组选择写入 localStorage，3 小时内重复打开直接展示；
 * - 逐场读取 3 小时内的单场分析缓存，作为批量分析的上下文复用；
 * - 关闭浮层会中止 SSE，打开另一组选择也会中止上一条流。
 */
export function useParlayAiAnalysis() {
  const [analysis, setAnalysis] = useState<ParlayAiAnalysisState | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const stateRef = useRef<ParlayAiAnalysisState | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => () => controllerRef.current?.abort(), [])

  function applyAnalysis(next: ParlayAiAnalysisState | null) {
    stateRef.current = next
    setAnalysis(next)
  }

  function update(
    key: string,
    patch: Partial<ParlayAiAnalysisState> | ((prev: ParlayAiAnalysisState) => Partial<ParlayAiAnalysisState>),
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

  async function run(base: ParlayAiAnalysisState) {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller

    try {
      const cachedById = new Map(
        (base.input.cachedLegAnalyses ?? []).map((cached) => [cached.id, cached]),
      )

      const done = await askParlayAnalysis(
        {
          pool: base.input.pool,
          passSummaryText: base.input.passSummaryText,
          betAmount: base.input.betAmount,
          maxBonus: base.input.maxBonus,
          entries: base.input.entries.map((entry) => ({
            matchId: entry.id,
            matchNo: entry.matchNo,
            teams: entry.teams,
            kickoffTime: entry.kickoffTime,
            options: entry.selectedOptions.map((option) => ({
              label: option.label,
              value: option.value,
            })),
            cachedAnalysis: cachedById.get(entry.id)?.content,
          })),
          thinking: false,
          maxTokens: 2_400,
          temperature: 0.4,
          signal: controller.signal,
        },
        {
          onContent: (delta) => {
            update(base.key, (prev) => ({
              // 第一个 token 到达前保持整理素材的 loading 态，避免出现空白正文
              status: prev.content ? prev.status : 'streaming',
              content: prev.content + delta,
            }))
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

      const summary = parseParlaySummary(current.content)
      const next: ParlayAiAnalysisState = {
        ...current,
        status: 'done',
        summary,
        elapsedMs: done.elapsedMs,
        usage: done.usage,
        fromCache: false,
      }
      stateRef.current = next
      writeAiAnalysisCache<ParlayAiCachePayload>(buildParlayAiCacheKey(base.key), {
        content: current.content,
        summary,
        elapsedMs: done.elapsedMs,
        usage: done.usage,
      })
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

  const open = useCallback((input: ParlayAnalysisInput, element: HTMLElement) => {
    if (input.entries.length === 0) {
      return
    }

    const key = buildParlayAnalysisKey(input)
    setAnchor(element)
    const inputWithCache = attachCachedLegAnalyses(input)

    const base: ParlayAiAnalysisState = {
      key,
      input: inputWithCache,
      status: 'loading',
      content: '',
      error: '',
      summary: null,
    }

    const cached = readAiAnalysisCache<ParlayAiCachePayload>(buildParlayAiCacheKey(key))
    if (cached) {
      controllerRef.current?.abort()
      applyAnalysis({
        ...base,
        status: 'done',
        content: cached.payload.content,
        summary: cached.payload.summary,
        elapsedMs: cached.payload.elapsedMs,
        usage: cached.payload.usage,
        fromCache: true,
      })
      return
    }

    applyAnalysis(base)
    void run(base)
    // run 只依赖 ref 与 setState，不需要进入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const retry = useCallback(() => {
    if (!analysis) {
      return
    }
    removeAiAnalysisCache(buildParlayAiCacheKey(analysis.key))
    const base: ParlayAiAnalysisState = {
      ...analysis,
      input: attachCachedLegAnalyses(analysis.input),
      status: 'loading',
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
