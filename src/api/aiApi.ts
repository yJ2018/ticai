import { apiUrl } from './base'
import { ApiError, request } from './httpClient'
import { type BffEnvelope } from './types'

/**
 * 前端调用大模型的唯一入口：同源 POST /api/ai-chat。
 *
 * 密钥只存在于服务端 `.env`（DEEPSEEK_API_KEY），
 * 千万不要改成 `VITE_DEEPSEEK_API_KEY` —— 带 VITE_ 前缀的变量会被打进浏览器 bundle。
 */

export type AiRole = 'system' | 'user' | 'assistant'

export type AiMessage = {
  role: AiRole
  content: string
}

export type AiChatOptions = {
  messages: AiMessage[]
  /** 0 ~ 2；思考模式下无效 */
  temperature?: number
  /** 1 ~ 8192，默认取服务端 DEEPSEEK_MAX_TOKENS（1024） */
  maxTokens?: number
  /** 要求模型只输出 JSON；提示词中必须包含 "json" 字样 */
  json?: boolean
  /** 覆盖服务端默认值：true 开启思考模式（更慢、更贵） */
  thinking?: boolean
  /** 思考强度；none 等价于关闭思考，low 更省 token、更快 */
  reasoningEffort?: 'none' | 'low' | 'high' | 'max'
  signal?: AbortSignal
}

export type AiUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
}

export type AiChatResult = {
  content: string
  /** 思考模式下的推理过程，未开启时为空 */
  reasoning?: string
  model: string
  finishReason: string
  /** 是否因 maxTokens 被截断 */
  truncated: boolean
  usage: AiUsage
  elapsedMs: number
}

const AI_CHAT_ENDPOINT = apiUrl('/api/ai-chat')
/** 服务端默认 60s 上游超时，这里留 10s 余量 */
const AI_TIMEOUT_MS = 70_000

export async function askAi(options: AiChatOptions): Promise<AiChatResult> {
  const { signal, ...body } = options

  const payload = await request<BffEnvelope<AiChatResult>>(AI_CHAT_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    timeoutMs: AI_TIMEOUT_MS,
  })

  if (!payload.success || !payload.data) {
    throw new Error(payload.errorMessage || 'AI 接口返回异常')
  }

  return payload.data
}

/** 单轮文本问答的便捷封装，适合"AI 解读""生成摘要"这类场景 */
export async function askAiText(
  prompt: string,
  options: Omit<AiChatOptions, 'messages'> & { system?: string } = {},
): Promise<string> {
  const { system, ...rest } = options
  const messages: AiMessage[] = []
  if (system) {
    messages.push({ role: 'system', content: system })
  }
  messages.push({ role: 'user', content: prompt })

  const { content } = await askAi({ messages, ...rest })
  return content
}

export type AiStreamDone = {
  model: string
  finishReason: string
  truncated: boolean
  usage: AiUsage
  elapsedMs: number
}

export type AiStreamHandlers = {
  onReasoning?: (delta: string) => void
  onContent?: (delta: string) => void
}

/**
 * 流式对话：服务端以 SSE 推送 thinking 的 reasoning_content 与正文增量。
 * 返回最终统计信息；正文与思考过程由调用方在回调里累积。
 */
export async function askAiStream(
  options: AiChatOptions,
  handlers: AiStreamHandlers = {},
): Promise<AiStreamDone> {
  const { signal, ...body } = options
  const timeoutSignal = AbortSignal.timeout(120_000)
  const requestSignal =
    signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeoutSignal])
      : (signal ?? timeoutSignal)

  let response: Response
  try {
    response = await fetch(AI_CHAT_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
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
    throw new ApiError('网络请求失败，请确认 BFF 服务已启动（npm run dev）', 0)
  }

  if (!response.ok) {
    throw new ApiError(await readStreamError(response), response.status)
  }
  if (!response.body) {
    throw new ApiError('当前环境不支持流式响应', 0)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done: AiStreamDone | null = null
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

    if (event === 'reasoning' && typeof payload.delta === 'string') {
      handlers.onReasoning?.(payload.delta)
    } else if (event === 'content' && typeof payload.delta === 'string') {
      handlers.onContent?.(payload.delta)
    } else if (event === 'done') {
      done = payload as unknown as AiStreamDone
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

async function readStreamError(response: Response) {
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
      // 非 JSON 响应，下面按纯文本兜底
    }
    if (text.length <= 200) {
      return text
    }
  } catch {
    // 读取 body 失败时使用状态码兜底
  }
  return `AI 请求失败: ${response.status}`
}
