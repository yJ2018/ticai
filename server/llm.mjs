import { HttpError, env, envInt, stripTrailingSlash } from './lib.mjs'

/**
 * DeepSeek 大模型客户端（OpenAI 兼容协议，零依赖）。
 * 文档：https://api-docs.deepseek.com/
 *
 * 约定：
 * - 密钥只在服务端进程内读取，浏览器永远只访问同源 /api/ai-chat；
 * - 不引第三方 SDK，直接 fetch /chat/completions，换供应商只需改 baseUrl + model；
 * - 默认关闭思考模式（DEEPSEEK_THINKING=1 可开），交互式功能延迟更低、更便宜。
 */

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-flash'
const MAX_OUTPUT_TOKENS = 8_192

export function createLlmConfig() {
  return {
    apiKey: env('DEEPSEEK_API_KEY'),
    baseUrl: stripTrailingSlash(env('DEEPSEEK_BASE_URL', DEFAULT_BASE_URL)),
    model: env('DEEPSEEK_MODEL', DEFAULT_MODEL),
    timeoutMs: envInt('DEEPSEEK_TIMEOUT_MS', 60_000),
    maxTokens: Math.min(envInt('DEEPSEEK_MAX_TOKENS', 1_024), MAX_OUTPUT_TOKENS),
    thinking: env('DEEPSEEK_THINKING', '0') === '1',
  }
}

function upstreamMessage(body, fallback) {
  const message = body?.error?.message ?? body?.message
  return typeof message === 'string' && message.trim() ? message : fallback
}

function mapUpstreamError(status, body) {
  if (status === 401) {
    return new HttpError(502, 'DeepSeek 鉴权失败，请检查服务端 DEEPSEEK_API_KEY 是否正确')
  }
  if (status === 402) {
    return new HttpError(502, 'DeepSeek 账户余额不足，请先充值')
  }
  if (status === 429) {
    return new HttpError(429, 'DeepSeek 触发限流，请稍后重试')
  }
  if (status === 400 || status === 422) {
    return new HttpError(502, `DeepSeek 拒绝了请求：${upstreamMessage(body, `HTTP ${status}`)}`)
  }
  return new HttpError(502, `DeepSeek 返回 HTTP ${status}`)
}

function readUsage(usage) {
  return {
    promptTokens: Number(usage?.prompt_tokens ?? 0),
    completionTokens: Number(usage?.completion_tokens ?? 0),
    totalTokens: Number(usage?.total_tokens ?? 0),
    cachedTokens: Number(
      usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0,
    ),
  }
}

function buildRequestBody(
  config,
  { messages, temperature, maxTokens, json, thinking, reasoningEffort },
  stream,
) {
  const useThinking = reasoningEffort === 'none' ? false : (thinking ?? config.thinking)
  // 推理 token 也计入 max_tokens，思考模式下给一个更宽松的默认值
  const defaultMaxTokens = useThinking ? Math.max(config.maxTokens, 4_096) : config.maxTokens

  const body = {
    model: config.model,
    messages,
    stream,
    // DeepSeek 默认开启思考模式，这里显式关闭，避免交互式请求又慢又贵
    thinking: { type: useThinking ? 'enabled' : 'disabled' },
    max_tokens:
      typeof maxTokens === 'number'
        ? Math.min(Math.max(Math.floor(maxTokens), 1), MAX_OUTPUT_TOKENS)
        : defaultMaxTokens,
  }

  if (useThinking && reasoningEffort && reasoningEffort !== 'none') {
    body.reasoning_effort = reasoningEffort
  }
  if (typeof temperature === 'number') {
    body.temperature = temperature
  }
  if (json) {
    body.response_format = { type: 'json_object' }
  }
  if (stream) {
    body.stream_options = { include_usage: true }
  }

  return body
}

function assertChatInput(config, messages) {
  if (!config.apiKey) {
    throw new HttpError(503, '服务端未配置 DEEPSEEK_API_KEY')
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HttpError(400, 'messages 不能为空')
  }
}

function combineSignals(timeoutSignal, signal) {
  if (!signal) {
    return timeoutSignal
  }
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([timeoutSignal, signal])
  }
  return timeoutSignal
}

/**
 * 发起一次非流式对话补全。
 * 成功时返回 { content, reasoning, model, finishReason, truncated, usage }。
 */
export async function chatCompletion(config, options = {}) {
  const { messages, signal } = options
  assertChatInput(config, messages)

  const body = buildRequestBody(config, options, false)
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs)
  const requestSignal =
    signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([timeoutSignal, signal])
      : (signal ?? timeoutSignal)

  let response
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    })
  } catch (error) {
    if (signal?.aborted) {
      throw new HttpError(499, '请求已取消')
    }
    if (timeoutSignal.aborted) {
      throw new HttpError(504, `DeepSeek 请求超时（${config.timeoutMs}ms）`)
    }
    throw new HttpError(
      502,
      `DeepSeek 连接失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw mapUpstreamError(response.status, payload)
  }

  const choice = payload?.choices?.[0]
  const content = typeof choice?.message?.content === 'string' ? choice.message.content : ''
  const reasoning =
    typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content : ''

  if (!content && !reasoning) {
    throw new HttpError(502, 'DeepSeek 返回了空内容')
  }

  return {
    content,
    reasoning,
    model: typeof payload?.model === 'string' ? payload.model : config.model,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : '',
    truncated: choice?.finish_reason === 'length',
    usage: readUsage(payload?.usage),
  }
}

function parseSseLine(line, state, handlers) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) {
    return
  }

  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') {
    return
  }

  let payload
  try {
    payload = JSON.parse(data)
  } catch {
    return
  }

  if (typeof payload?.model === 'string') {
    state.model = payload.model
  }
  if (payload?.usage) {
    state.usage = readUsage(payload.usage)
  }

  const choice = payload?.choices?.[0]
  if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
    state.finishReason = choice.finish_reason
  }

  const delta = choice?.delta
  if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
    state.received = true
    handlers.onReasoning?.(delta.reasoning_content)
  }
  if (typeof delta?.content === 'string' && delta.content) {
    state.received = true
    handlers.onContent?.(delta.content)
  }
}

/**
 * 流式对话补全：把 DeepSeek 的增量（思考过程 / 正文）回调给调用方。
 * 返回 { model, finishReason, truncated, usage }，正文由调用方自行拼接。
 */
export async function streamChatCompletion(config, options = {}, handlers = {}) {
  const { messages } = options
  assertChatInput(config, messages)

  const body = buildRequestBody(config, options, true)
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs)
  const signal = combineSignals(timeoutSignal, handlers.signal)

  let response
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new HttpError(504, `DeepSeek 请求超时（${config.timeoutMs}ms）`)
    }
    if (handlers.signal?.aborted) {
      throw new HttpError(499, '请求已取消')
    }
    throw new HttpError(
      502,
      `DeepSeek 连接失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!response.ok) {
    const text = await response.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = null
    }
    throw mapUpstreamError(response.status, payload)
  }

  if (!response.body) {
    throw new HttpError(502, 'DeepSeek 未返回可读取的数据流')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const state = {
    model: config.model,
    finishReason: '',
    usage: readUsage(null),
    received: false,
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })
      let newlineIndex
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        parseSseLine(line, state, handlers)
      }
    }

    buffer += decoder.decode()
    if (buffer.trim()) {
      parseSseLine(buffer, state, handlers)
    }
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new HttpError(504, `DeepSeek 请求超时（${config.timeoutMs}ms）`)
    }
    if (handlers.signal?.aborted) {
      throw new HttpError(499, '请求已取消')
    }
    throw new HttpError(
      502,
      `DeepSeek 数据流中断：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!state.received) {
    throw new HttpError(502, 'DeepSeek 返回了空内容')
  }

  return {
    model: state.model,
    finishReason: state.finishReason,
    truncated: state.finishReason === 'length',
    usage: state.usage,
  }
}
