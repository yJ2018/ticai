import { useCallback, useEffect, useRef, useState } from 'react'
import { askAiStream, type AiStreamDone } from '../../api/aiApi'
import {
  buildParlayAnalysisKey,
  buildParlayAnalysisMessages,
  parseParlaySummary,
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
}

/**
 * 方案级 AI 分析状态机：
 * - 只围绕当前方案里已选的场次和选项分析；
 * - 同一组选择在当前页面会话内缓存，关闭浮层后再打开不重复计费；
 * - 关闭浮层会中止 SSE，打开另一组选择也会中止上一条流。
 */
export function useParlayAiAnalysis() {
  const [analysis, setAnalysis] = useState<ParlayAiAnalysisState | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const stateRef = useRef<ParlayAiAnalysisState | null>(null)
  const cacheRef = useRef(new Map<string, ParlayAiAnalysisState>())
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
      const done = await askAiStream(
        {
          messages: buildParlayAnalysisMessages(base.input),
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

      const next: ParlayAiAnalysisState = {
        ...current,
        status: 'done',
        summary: parseParlaySummary(current.content),
        elapsedMs: done.elapsedMs,
        usage: done.usage,
      }
      stateRef.current = next
      cacheRef.current.set(base.key, next)
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

    const cached = cacheRef.current.get(key)
    if (cached) {
      controllerRef.current?.abort()
      applyAnalysis(cached)
      return
    }

    const base: ParlayAiAnalysisState = {
      key,
      input,
      status: 'loading',
      content: '',
      error: '',
      summary: null,
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
    cacheRef.current.delete(analysis.key)
    const base: ParlayAiAnalysisState = {
      ...analysis,
      status: 'loading',
      content: '',
      error: '',
      summary: null,
      elapsedMs: undefined,
      usage: undefined,
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
