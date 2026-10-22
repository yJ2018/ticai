import { loadMatchContext, loadWeather } from '../ai/context.mjs'
import { POOL_KEYS, buildAnalysisPrompt, weatherLabel } from '../ai/prompt.mjs'
import {
  HttpError,
  clientIpFor,
  createRateLimiter,
  readJsonBody,
  sendData,
} from '../lib.mjs'
import { chatCompletion, streamChatCompletion } from '../llm.mjs'
import { createVenueWeatherService } from '../venue.mjs'

/**
 * 单场 AI 分析：客户端只传 matchId + pool。
 *
 * 提示词、官方数据、天气全部在服务端装配，好处：
 * - 提示词改动随服务端发布生效，不受浏览器缓存影响；
 * - 客户端不再把整场比赛数据塞进请求体；
 * - 前端从 3 个请求（天气 + 详情 + 对话）降到 1 个。
 */

const TRUST_PROXY = process.env.TRUST_PROXY !== '0'
const MAX_TOKENS = 2_048

export function createAnalysisHandler(config) {
  const venueService = createVenueWeatherService(config)
  const rateLimiter = createRateLimiter({ limit: config.rateLimit.aiPerMinute })

  async function streamAnalysis(ctx, { messages, options, meta }) {
    const { res } = ctx
    const controller = new AbortController()
    const abortUpstream = () => controller.abort()
    res.on('close', abortUpstream)

    let started = false
    const write = (event, data) => {
      if (res.destroyed || res.writableEnded) {
        return
      }
      if (!started) {
        started = true
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

    // 先发 meta：前端可以立刻显示天气、提示词长度，不用等首字节
    write('meta', meta)

    const startedAt = Date.now()

    try {
      const result = await streamChatCompletion(
        config.llm,
        { messages, ...options },
        {
          signal: controller.signal,
          onReasoning: (delta) => write('reasoning', { delta }),
          onContent: (delta) => write('content', { delta }),
        },
      )
      write('done', { ...result, elapsedMs: Date.now() - startedAt })
      res.end()
    } catch (error) {
      if (controller.signal.aborted) {
        res.end()
        return
      }
      const status = error instanceof HttpError ? error.status : 502
      const message = error instanceof Error ? error.message : String(error)
      if (!started) {
        throw error instanceof HttpError ? error : new HttpError(status, message)
      }
      write('error', { status, message })
      res.end()
    } finally {
      res.off('close', abortUpstream)
    }
  }

  return async function analysis(ctx) {
    const body = await readJsonBody(ctx.req, { maxBytes: 8 * 1024 })

    const matchId = Number(body?.matchId)
    if (!Number.isInteger(matchId) || matchId <= 0) {
      throw new HttpError(400, 'matchId 必须是正整数')
    }

    const pool = String(body?.pool ?? 'ttg')
    if (!POOL_KEYS.includes(pool)) {
      throw new HttpError(400, `不支持的玩法：${pool}`)
    }

    rateLimiter(clientIpFor(ctx.req, { trustProxy: TRUST_PROXY }))

    const context = await loadMatchContext(config, matchId)
    if (!context) {
      throw new HttpError(404, `没有这场比赛：${matchId}（可能还没抓取）`)
    }

    const weather = await loadWeather(venueService, context.match)
    const prompt = buildAnalysisPrompt({ ...context, weather, pool })

    const options = {
      thinking: body?.thinking === true,
      maxTokens: Math.min(Math.max(Number(body?.maxTokens) || 1_500, 1), MAX_TOKENS),
      temperature: typeof body?.temperature === 'number' ? body.temperature : 0.4,
    }

    const messages = [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ]

    const meta = {
      matchId,
      pool,
      weatherLabel: weatherLabel(weather),
      promptChars: prompt.chars,
      hasOdds: Boolean(context.odds),
      feeds: Object.keys(context.feeds),
    }

    if (body?.stream === true) {
      await streamAnalysis(ctx, { messages, options, meta })
      return
    }

    const startedAt = Date.now()
    const result = await chatCompletion(config.llm, { messages, ...options })
    sendData(ctx.res, { ...result, meta, elapsedMs: Date.now() - startedAt })
  }
}
