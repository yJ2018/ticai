import {
  HttpError,
  clientIpFor,
  createRateLimiter,
  readJsonBody,
  sendData,
} from '../lib.mjs'
import { chatCompletion, streamChatCompletion } from '../llm.mjs'

/**
 * DeepSeek 对话代理。密钥只在服务端，浏览器只发同源/跨域 POST。
 *
 * 流式走 SSE：首个增量到达前不写响应头，这样鉴权/限流/参数错误
 * 仍然能用普通 JSON 错误返回。
 */

const AI_ROLES = new Set(['system', 'user', 'assistant'])
const AI_MAX_MESSAGES = 40
const AI_MAX_MESSAGE_CHARS = 15_000
const AI_MAX_TOTAL_CHARS = 30_000
const AI_MAX_OUTPUT_TOKENS = 8_192
const AI_MAX_BODY_BYTES = 256 * 1024

const TRUST_PROXY = process.env.TRUST_PROXY !== '0'

function parseAiChatBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, '请求体必须是 JSON 对象')
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new HttpError(400, 'messages 必须是非空数组')
  }
  if (body.messages.length > AI_MAX_MESSAGES) {
    throw new HttpError(400, `messages 最多 ${AI_MAX_MESSAGES} 条`)
  }

  let totalChars = 0
  const messages = body.messages.map((message, index) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new HttpError(400, `messages[${index}] 必须是对象`)
    }
    if (!AI_ROLES.has(message.role)) {
      throw new HttpError(400, `messages[${index}].role 只能是 system / user / assistant`)
    }
    if (typeof message.content !== 'string' || !message.content.trim()) {
      throw new HttpError(400, `messages[${index}].content 不能为空`)
    }
    if (message.content.length > AI_MAX_MESSAGE_CHARS) {
      throw new HttpError(413, `messages[${index}].content 超过 ${AI_MAX_MESSAGE_CHARS} 字符`)
    }
    totalChars += message.content.length
    return { role: message.role, content: message.content }
  })

  if (totalChars > AI_MAX_TOTAL_CHARS) {
    throw new HttpError(413, `对话内容过长（${totalChars} 字符，上限 ${AI_MAX_TOTAL_CHARS}）`)
  }

  const options = {}
  let stream = false

  if (body.stream !== undefined) {
    if (typeof body.stream !== 'boolean') {
      throw new HttpError(400, 'stream 必须是布尔值')
    }
    stream = body.stream
  }

  if (body.temperature !== undefined) {
    const temperature = Number(body.temperature)
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new HttpError(400, 'temperature 必须在 0 ~ 2 之间')
    }
    options.temperature = temperature
  }

  if (body.maxTokens !== undefined) {
    const maxTokens = Number(body.maxTokens)
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > AI_MAX_OUTPUT_TOKENS) {
      throw new HttpError(400, `maxTokens 必须是 1 ~ ${AI_MAX_OUTPUT_TOKENS} 的整数`)
    }
    options.maxTokens = maxTokens
  }

  if (body.json !== undefined) {
    if (typeof body.json !== 'boolean') {
      throw new HttpError(400, 'json 必须是布尔值')
    }
    options.json = body.json
  }

  if (body.thinking !== undefined) {
    if (typeof body.thinking !== 'boolean') {
      throw new HttpError(400, 'thinking 必须是布尔值')
    }
    options.thinking = body.thinking
  }

  if (body.reasoningEffort !== undefined) {
    if (!['none', 'low', 'high', 'max'].includes(body.reasoningEffort)) {
      throw new HttpError(400, 'reasoningEffort 只能是 none / low / high / max')
    }
    options.reasoningEffort = body.reasoningEffort
  }

  if (options.json && !messages.some((message) => /json/i.test(message.content))) {
    throw new HttpError(400, '启用 json 时，system 或 user 提示词中必须包含 "json" 字样')
  }

  return { messages, options, stream }
}

export function createAiHandlers(config) {
  const aiRateLimiter = createRateLimiter({ limit: config.rateLimit.aiPerMinute })

  async function streamAiChat(ctx, { messages, options }) {
    const { req, res } = ctx
    const controller = new AbortController()
    const abortUpstream = () => controller.abort()
    res.on('close', abortUpstream)

    let streamStarted = false
    const writeEvent = (event, data) => {
      if (res.destroyed || res.writableEnded) {
        return
      }
      if (!streamStarted) {
        streamStarted = true
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          ...ctx.corsHeaders(),
        })
        res.flushHeaders?.()
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const startedAt = Date.now()

    try {
      const result = await streamChatCompletion(
        config.llm,
        { messages, ...options },
        {
          signal: controller.signal,
          onReasoning: (delta) => writeEvent('reasoning', { delta }),
          onContent: (delta) => writeEvent('content', { delta }),
        },
      )

      writeEvent('done', { ...result, elapsedMs: Date.now() - startedAt })
      res.end()
    } catch (error) {
      if (controller.signal.aborted) {
        res.end()
        return
      }

      const status = error instanceof HttpError ? error.status : 502
      const message = error instanceof Error ? error.message : String(error)

      if (!streamStarted) {
        throw error instanceof HttpError ? error : new HttpError(status, message)
      }

      writeEvent('error', { status, message })
      res.end()
    } finally {
      res.off('close', abortUpstream)
    }
  }

  async function aiChat(ctx) {
    const body = await readJsonBody(ctx.req, { maxBytes: AI_MAX_BODY_BYTES })
    const { messages, options, stream } = parseAiChatBody(body)

    aiRateLimiter(clientIpFor(ctx.req, { trustProxy: TRUST_PROXY }))

    if (stream) {
      await streamAiChat(ctx, { messages, options })
      return
    }

    const startedAt = Date.now()
    const result = await chatCompletion(config.llm, { messages, ...options })
    sendData(ctx.res, { ...result, elapsedMs: Date.now() - startedAt })
  }

  return { aiChat }
}
