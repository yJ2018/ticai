import { formatKickoff, loadParlayContext } from '../ai/parlay-context.mjs'
import { buildParlayPrompt, describeLegOdds, formatInjuryBrief } from '../ai/parlay-prompt.mjs'
import {
  HttpError,
  clientIpFor,
  createRateLimiter,
  readJsonBody,
  sendData,
} from '../lib.mjs'
import { chatCompletion, streamChatCompletion } from '../llm.mjs'

/**
 * 串关 AI 分析：客户端只提交「选了哪几场、哪些选项」，
 * 赔率与伤停由服务端按 matchId 从库里补齐，提示词不再进 bundle。
 */

const TRUST_PROXY = process.env.TRUST_PROXY !== '0'
const MAX_LEGS = 10
const MAX_OPTIONS_PER_LEG = 6
const MAX_CACHED_CHARS = 900
const MAX_TOKENS = 4_096

function textOf(value, limit = 40) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function parseBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, '请求体必须是 JSON 对象')
  }

  const entries = Array.isArray(body.entries) ? body.entries : []
  if (entries.length === 0) {
    throw new HttpError(400, 'entries 不能为空')
  }
  if (entries.length > MAX_LEGS) {
    throw new HttpError(400, `串关最多 ${MAX_LEGS} 场`)
  }

  const legs = entries.map((entry, index) => {
    const matchId = Number(entry?.matchId)
    if (!Number.isInteger(matchId) || matchId <= 0) {
      throw new HttpError(400, `entries[${index}].matchId 不合法`)
    }

    const rawOptions = Array.isArray(entry?.options) ? entry.options : []
    if (rawOptions.length === 0) {
      throw new HttpError(400, `entries[${index}].options 不能为空`)
    }
    if (rawOptions.length > MAX_OPTIONS_PER_LEG) {
      throw new HttpError(400, `entries[${index}].options 最多 ${MAX_OPTIONS_PER_LEG} 个`)
    }

    const options = rawOptions.map((option) => ({
      label: textOf(option?.label, 24),
      value: textOf(option?.value, 12),
    }))

    return {
      order: index + 1,
      matchId,
      matchNo: textOf(entry?.matchNo, 16),
      teams: textOf(entry?.teams, 40),
      kickoffTime: textOf(entry?.kickoffTime, 24),
      options,
      cachedAnalysis: textOf(entry?.cachedAnalysis, MAX_CACHED_CHARS),
    }
  })

  return {
    pool: textOf(body.pool, 16) || 'ttg',
    passSummaryText: textOf(body.passSummaryText, 40),
    betAmount: Number(body.betAmount) || 0,
    maxBonus: Number(body.maxBonus) || 0,
    legs,
    stream: body.stream === true,
    thinking: body.thinking === true,
    maxTokens: Math.min(Math.max(Number(body.maxTokens) || 2_400, 1), MAX_TOKENS),
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.4,
  }
}

function createSseWriter(res, corsHeaders) {
  let started = false
  return (event, data) => {
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
        ...corsHeaders,
      })
      res.flushHeaders?.()
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    return started
  }
}

export function createParlayHandler(config) {
  const rateLimiter = createRateLimiter({ limit: config.rateLimit.aiPerMinute })

  async function streamParlay(ctx, { messages, options, meta }) {
    const { res } = ctx
    const controller = new AbortController()
    const abortUpstream = () => controller.abort()
    res.on('close', abortUpstream)

    const write = createSseWriter(res, ctx.corsHeaders())
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
      write('error', { status, message })
      res.end()
    } finally {
      res.off('close', abortUpstream)
    }
  }

  return async function parlay(ctx) {
    const body = await readJsonBody(ctx.req, { maxBytes: 64 * 1024 })
    const input = parseBody(body)

    rateLimiter(clientIpFor(ctx.req, { trustProxy: TRUST_PROXY }))

    const context = await loadParlayContext(
      config,
      input.legs.map((leg) => leg.matchId),
    )

    let matched = 0
    const legs = input.legs.map((leg) => {
      const found = context.get(String(leg.matchId))
      if (found) {
        matched += 1
      }
      const selected = leg.options
        .map((option) => `${option.label}${option.value ? `（${option.value}）` : ''}`)
        .join('、')

      return {
        order: leg.order,
        matchNo: leg.matchNo || found?.match?.match_num_str || '',
        teams: leg.teams || (found ? `${found.match.home_name} vs ${found.match.away_name}` : ''),
        league: found?.match?.league_name ?? '未知赛事',
        kickoff: leg.kickoffTime || formatKickoff(found?.match?.kickoff_at) || '未知时间',
        selected,
        odds: found ? describeLegOdds(found.odds, input.pool) : '',
        injuries: found
          ? formatInjuryBrief(
              { injury: found.injury ?? {} },
              found.match.home_name,
              found.match.away_name,
            )
          : '',
        cachedAnalysis: leg.cachedAnalysis,
      }
    })

    const prompt = buildParlayPrompt({
      pool: input.pool,
      passSummaryText: input.passSummaryText,
      betAmount: input.betAmount,
      maxBonus: input.maxBonus,
      legs,
    })

    const messages = [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ]

    const options = {
      thinking: input.thinking,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
    }

    const meta = {
      legs: legs.length,
      matched,
      promptChars: prompt.chars,
      pool: input.pool,
    }

    if (input.stream) {
      await streamParlay(ctx, { messages, options, meta })
      return
    }

    const startedAt = Date.now()
    const result = await chatCompletion(config.llm, { messages, ...options })
    sendData(ctx.res, { ...result, meta, elapsedMs: Date.now() - startedAt })
  }
}
