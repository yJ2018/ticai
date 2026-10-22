import { apiUrl } from './base'
import { type AiUsage } from './aiApi'
import { ApiError } from './httpClient'

/**
 * AI 分析的通用 SSE 客户端。
 *
 * 单场（/api/ai-analysis）与串关（/api/ai-parlay）共用同一个解析器，
 * 只差请求体——两边都是「服务端装配提示词，客户端只发结构化参数」。
 */

export type AnalysisMeta = {
  matchId?: number
  pool?: string
  weatherLabel?: string
  promptChars?: number
  hasOdds?: boolean
  feeds?: string[]
  legs?: number
  matched?: number
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

export type StreamOptions = {
  signal?: AbortSignal
  /** 前端侧总超时，默认 120s */
  timeoutMs?: number
  /** 超时提示语 */
  timeoutMessage?: string
}

/** 发起一次 SSE 请求并消费事件流。 */
export async function streamSseJson(
  endpoint: string,
  payload: Record<string, unknown>,
  handlers: AnalysisHandlers = {},
  options: StreamOptions = {},
): Promise<AnalysisDone> {
  const { signal, timeoutMs = 120_000, timeoutMessage = 'AI 分析超时，请重试' } = options
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const requestSignal =
    signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeoutSignal])
      : (signal ?? timeoutSignal)

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ ...payload, stream: true }),
      signal: requestSignal,
    })
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    if (timeoutSignal.aborted) {
      throw new ApiError(timeoutMessage, 504)
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

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(dataLines.join('\n')) as Record<string, unknown>
    } catch {
      return
    }

    if (event === 'meta') {
      handlers.onMeta?.(parsed as unknown as AnalysisMeta)
    } else if (event === 'reasoning' && typeof parsed.delta === 'string') {
      handlers.onReasoning?.(parsed.delta)
    } else if (event === 'content' && typeof parsed.delta === 'string') {
      handlers.onContent?.(parsed.delta)
    } else if (event === 'done') {
      done = parsed as unknown as AnalysisDone
    } else if (event === 'error') {
      streamError = new ApiError(
        typeof parsed.message === 'string' ? parsed.message : 'AI 分析失败',
        typeof parsed.status === 'number' ? parsed.status : 502,
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
      throw new ApiError(timeoutMessage, 504)
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

export type AnalysisRequest = {
  matchId: number
  pool: string
  thinking?: boolean
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  timeoutMs?: number
}

/** 单场分析：只提交 matchId + pool。 */
export async function askMatchAnalysis(
  request: AnalysisRequest,
  handlers: AnalysisHandlers = {},
): Promise<AnalysisDone> {
  const { signal, timeoutMs, ...body } = request

  return streamSseJson(
    apiUrl('/api/ai-analysis'),
    body as unknown as Record<string, unknown>,
    handlers,
    { signal, timeoutMs },
  )
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
