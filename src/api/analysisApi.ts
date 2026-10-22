import { type AiUsage } from './aiApi'
import { apiUrl } from './base'
import { ApiError } from './httpClient'

/**
 * 单场 AI 分析：只提交 matchId + pool。
 *
 * 提示词、官方数据、天气都在服务端装配（apps/api/src/ai/prompt.mjs），
 * 客户端不再把整段 messages 塞进请求体——提示词改版不需要前端发版。
 */

export type AnalysisMeta = {
  matchId: number
  pool: string
  weatherLabel: string
  /** 服务端实际拼出来的 user 提示词字符数，便于观察 token 变化 */
  promptChars: number
  hasOdds: boolean
  feeds: string[]
}

export type AnalysisDone = {
  model: string
  finishReason: string
  truncated: boolean
  usage: AiUsage
  elapsedMs: number
}

export type AnalysisHandlers = {
  onMeta?: (meta: AnalysisMeta) => void
  onReasoning?: (delta: string) => void
  onContent?: (delta: string) => void
}

export type AnalysisRequest = {
  matchId: number
  pool: string
  thinking?: boolean
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  /** 前端侧总超时，默认 120s */
  timeoutMs?: number
}

const ENDPOINT = apiUrl('/api/ai-analysis')

export async function askMatchAnalysis(
  request: AnalysisRequest,
  handlers: AnalysisHandlers = {},
): Promise<AnalysisDone> {
  const { signal, timeoutMs = 120_000, ...body } = request
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const requestSignal =
    signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeoutSignal])
      : (signal ?? timeoutSignal)

  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ ...body, stream: true }),
      signal: requestSignal,
    })
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    if (timeoutSignal.aborted) {
      throw new ApiError('AI 分析超时，请重试', 504)
    }
    throw new ApiError('网络请求失败，请确认 API 服务已启动', 0)
  }

  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status)
  }
  if (!response.body) {
    throw new ApiError('当前环境不支持流式响应', 0)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done: AnalysisDone | null = null
  let streamError: ApiError | null = null

  function handleBlock(block: string) {
    let event = 'message'
    const dataLines: string[] = []

    for (const rawLine of block.split('\n')) {
      if (rawLine.startsWith('event:')) {
        event = rawLine.slice(6).trim()
      } else if (rawLine.startsWith('data:')) {
        dataLines.push(rawLine.slice(5).trim())
      }
    }

    if (dataLines.length === 0) {
      return
    }

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(dataLines.join('\n')) as Record<string, unknown>
    } catch {
      return
    }

    if (event === 'meta') {
      handlers.onMeta?.(payload as unknown as AnalysisMeta)
    } else if (event === 'reasoning' && typeof payload.delta === 'string') {
      handlers.onReasoning?.(payload.delta)
    } else if (event === 'content' && typeof payload.delta === 'string') {
      handlers.onContent?.(payload.delta)
    } else if (event === 'done') {
      done = payload as unknown as AnalysisDone
    } else if (event === 'error') {
      streamError = new ApiError(
        typeof payload.message === 'string' ? payload.message : 'AI 分析失败',
        typeof payload.status === 'number' ? payload.status : 502,
      )
    }
  }

  try {
    while (true) {
      const { done: finished, value } = await reader.read()
      if (finished) {
        break
      }
      buffer += decoder.decode(value, { stream: true })

      let boundary
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        handleBlock(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
      }
    }

    buffer += decoder.decode()
    if (buffer.trim()) {
      handleBlock(buffer)
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    if (timeoutSignal.aborted) {
      throw new ApiError('AI 分析超时，请重试', 504)
    }
    throw new ApiError('AI 分析连接中断，请重试', 0)
  } finally {
    reader.releaseLock()
  }

  if (streamError) {
    throw streamError
  }
  if (!done) {
    throw new ApiError('AI 分析流意外中断，请重试', 0)
  }

  return done
}

async function readErrorMessage(response: Response) {
  try {
    const text = await response.text()
    if (!text) {
      return `AI 请求失败: ${response.status}`
    }
    try {
      const body = JSON.parse(text) as { errorMessage?: unknown; message?: unknown }
      const message = body.errorMessage ?? body.message
      if (typeof message === 'string' && message.trim()) {
        return message
      }
    } catch {
      // 非 JSON，按纯文本兜底
    }
    if (text.length <= 200) {
      return text
    }
  } catch {
    // 读取 body 失败时用状态码
  }
  return `AI 请求失败: ${response.status}`
}
