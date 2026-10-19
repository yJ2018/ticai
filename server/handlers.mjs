import {
  HttpError,
  createTtlCache,
  env,
  envInt,
  fetchUpstreamJson,
  readJsonBody,
  sendData,
  sendJson,
  stripTrailingSlash,
} from './lib.mjs'
import { chatCompletion, createLlmConfig, streamChatCompletion } from './llm.mjs'
import { createVenueWeatherService } from './venue.mjs'

const POOL_TYPES = new Set(['had', 'crs', 'ttg', 'hafu', 'mixed'])

const CONSTELLATIONS = new Set([
  '白羊座',
  '金牛座',
  '双子座',
  '巨蟹座',
  '狮子座',
  '处女座',
  '天秤座',
  '天蝎座',
  '射手座',
  '摩羯座',
  '水瓶座',
  '双鱼座',
])

const HOROSCOPE_TYPES = new Set(['today', 'tomorrow', 'week', 'month', 'year'])

const AI_ROLES = new Set(['system', 'user', 'assistant'])
const AI_MAX_MESSAGES = 40
const AI_MAX_MESSAGE_CHARS = 15_000
const AI_MAX_TOTAL_CHARS = 30_000
const AI_MAX_OUTPUT_TOKENS = 8_192
const AI_MAX_BODY_BYTES = 256 * 1024

/**
 * 从环境变量构建运行期配置。必须在 loadEnvFile() 之后调用。
 */
export function createApiConfig() {
  return {
    sportteryBase: stripTrailingSlash(env('SPORTTERY_BASE', 'https://webapi.sporttery.cn')),
    juheWebBase: stripTrailingSlash(env('JUHE_WEB_BASE', 'http://web.juhe.cn')),
    juheWeatherBase: stripTrailingSlash(env('JUHE_WEATHER_BASE', 'http://v.juhe.cn')),
    juheIpBase: stripTrailingSlash(env('JUHE_IP_BASE', 'http://apis.juhe.cn')),
    timeoutMs: envInt('UPSTREAM_TIMEOUT_MS', 8_000),
    keys: {
      weather: env('JUHE_WEATHER_KEY'),
      horoscope: env('JUHE_HOROSCOPE_KEY'),
      ip: env('JUHE_IP_KEY'),
    },
    llm: createLlmConfig(),
  }
}

function poolCodeFor(poolType) {
  if (poolType === 'mixed') {
    return ''
  }
  if (poolType === 'had') {
    return 'hhad,had'
  }
  return poolType
}

function textParam(url, name, fallback = '') {
  const raw = url.searchParams.get(name)
  if (raw === null) {
    return fallback
  }
  // 去掉控制字符并按字符长度截断，避免把任意内容透传给上游
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64)
}

function intParam(url, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new HttpError(400, `参数 ${name} 必须是数字`)
  }
  return Math.min(Math.max(Math.floor(value), min), max)
}

function toString(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

function isPrivateIp(ip) {
  if (!ip) {
    return true
  }
  if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.')) {
    return true
  }
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) {
    return true
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
    return true
  }
  return ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')
}

function clientIpFor(req) {
  const forwarded = req.headers['x-forwarded-for']
  const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : (forwarded ?? '')
  const rawIp = firstForwarded.split(',')[0].trim() || req.socket?.remoteAddress || ''
  return rawIp.replace(/^::ffff:/, '')
}

/**
 * 简单的 IP 维度滑动窗口限流：单进程内存实现，够用于个人项目。
 * 多实例部署（Vercel）时每个实例各自计数，不能当作严格配额。
 */
function createRateLimiter({ limit, windowMs = 60_000, maxKeys = 5_000 }) {
  const hits = new Map()

  return function hit(key) {
    if (!limit) {
      return
    }

    const now = Date.now()
    const recent = (hits.get(key) ?? []).filter((stamp) => now - stamp < windowMs)
    if (recent.length >= limit) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000))
      throw new HttpError(429, `AI 调用过于频繁，请 ${retryAfter} 秒后重试`)
    }

    recent.push(now)
    hits.set(key, recent)

    if (hits.size > maxKeys) {
      for (const [storedKey, stamps] of hits) {
        if (!stamps.some((stamp) => now - stamp < windowMs)) {
          hits.delete(storedKey)
        }
      }
      if (hits.size > maxKeys) {
        hits.delete(hits.keys().next().value)
      }
    }
  }
}

/**
 * 校验并裁剪前端传来的对话请求，避免把任意结构透传给上游、也避免失控的 token 消耗。
 */
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
    // DeepSeek JSON Output 要求提示词里出现 "json"，否则模型可能一直输出空白直到耗尽 token
    throw new HttpError(400, '启用 json 时，system 或 user 提示词中必须包含 "json" 字样')
  }

  return { messages, options, stream }
}

export function createHandlers(config) {
  const matchCache = createTtlCache({ ttlMs: 20_000, maxEntries: 10 })
  const historyCache = createTtlCache({ ttlMs: 60_000, maxEntries: 200 })
  const horoscopeCache = createTtlCache({ ttlMs: 10 * 60_000, maxEntries: 120 })
  const weatherCache = createTtlCache({ ttlMs: 10 * 60_000, maxEntries: 200 })
  const ipCache = createTtlCache({ ttlMs: 30 * 60_000, maxEntries: 500 })
  const upstreamTimeout = config.timeoutMs
  const aiRateLimiter = createRateLimiter({ limit: envInt('AI_RATE_LIMIT_PER_MIN', 10) })
  const venueRateLimiter = createRateLimiter({ limit: envInt('VENUE_RATE_LIMIT_PER_MIN', 20) })
  const venueService = createVenueWeatherService(config)

  async function matches(req, res, url) {
    const poolType = textParam(url, 'poolType', 'mixed') || 'mixed'
    if (!POOL_TYPES.has(poolType)) {
      throw new HttpError(400, `不支持的玩法池：${poolType}`)
    }

    const cached = matchCache.get(poolType)
    if (cached) {
      sendJson(res, 200, cached, { 'x-cache': 'hit' })
      return
    }

    const query = new URLSearchParams({ channel: 'c' })
    const poolCode = poolCodeFor(poolType)
    if (poolCode) {
      query.set('poolCode', poolCode)
    }

    const upstream = await fetchUpstreamJson(
      `${config.sportteryBase}/gateway/uniform/football/getMatchCalculatorV1.qry?${query.toString()}`,
      { timeoutMs: upstreamTimeout },
    )

    if (!upstream || typeof upstream !== 'object') {
      throw new HttpError(502, '竞彩接口返回结构异常')
    }

    // 保持体彩信封（success/errorCode/errorMessage/value）原样透传，客户端契约不变
    matchCache.set(poolType, upstream)
    sendJson(res, 200, upstream, { 'x-cache': 'miss' })
  }

  async function history(req, res, url) {
    const gameNo = textParam(url, 'gameNo')
    if (!/^\d{4,8}$/.test(gameNo)) {
      throw new HttpError(400, 'gameNo 参数不合法')
    }

    const pageNo = intParam(url, 'pageNo', 1, { min: 1, max: 10_000 })
    const pageSize = intParam(url, 'pageSize', 30, { min: 1, max: 100 })
    const provinceId = intParam(url, 'provinceId', 0, { min: 0, max: 99 })
    const isVerify = intParam(url, 'isVerify', 1, { min: 0, max: 1 })
    const termLimits = intParam(url, 'termLimits', 0, { min: 0, max: 20 })

    const cacheKey = `${gameNo}|${pageNo}|${pageSize}|${provinceId}|${isVerify}|${termLimits}`
    const cached = historyCache.get(cacheKey)
    if (cached) {
      sendJson(res, 200, cached, { 'x-cache': 'hit' })
      return
    }

    const query = new URLSearchParams({
      gameNo,
      provinceId: String(provinceId),
      pageSize: String(pageSize),
      isVerify: String(isVerify),
      termLimits: String(termLimits),
      pageNo: String(pageNo),
    })

    const upstream = await fetchUpstreamJson(
      `${config.sportteryBase}/gateway/lottery/getHistoryPageListV1.qry?${query.toString()}`,
      { timeoutMs: upstreamTimeout },
    )

    if (!upstream || typeof upstream !== 'object') {
      throw new HttpError(502, '开奖接口返回结构异常')
    }

    historyCache.set(cacheKey, upstream)
    sendJson(res, 200, upstream, { 'x-cache': 'miss' })
  }

  async function horoscope(req, res, url) {
    const consName = textParam(url, 'consName')
    if (!CONSTELLATIONS.has(consName)) {
      throw new HttpError(400, 'consName 参数不合法')
    }

    const type = textParam(url, 'type', 'today') || 'today'
    if (!HOROSCOPE_TYPES.has(type)) {
      throw new HttpError(400, 'type 参数不合法')
    }

    if (!config.keys.horoscope) {
      throw new HttpError(503, '服务端未配置 JUHE_HOROSCOPE_KEY')
    }

    const cacheKey = `${consName}|${type}`
    const cached = horoscopeCache.get(cacheKey)
    if (cached) {
      sendData(res, cached, { 'x-cache': 'hit' })
      return
    }

    const query = new URLSearchParams({ key: config.keys.horoscope, consName, type })
    const upstream = await fetchUpstreamJson(
      `${config.juheWebBase}/constellation/getAll?${query.toString()}`,
      { timeoutMs: upstreamTimeout },
    )

    const errorCode = Number(upstream?.error_code ?? upstream?.resultcode ?? 0)
    if (errorCode !== 0) {
      throw new HttpError(502, toString(upstream?.reason) || '星座运势接口返回异常')
    }

    horoscopeCache.set(cacheKey, upstream)
    sendData(res, upstream, { 'x-cache': 'miss' })
  }

  async function weather(req, res, url) {
    const cityname = textParam(url, 'cityname')
    if (!cityname) {
      throw new HttpError(400, '缺少 cityname 参数')
    }

    if (!config.keys.weather) {
      throw new HttpError(503, '服务端未配置 JUHE_WEATHER_KEY')
    }

    const dtype = textParam(url, 'dtype')
    const format = textParam(url, 'format')
    const cacheKey = `${cityname}|${dtype}|${format}`
    const cached = weatherCache.get(cacheKey)
    if (cached) {
      sendData(res, cached, { 'x-cache': 'hit' })
      return
    }

    const query = new URLSearchParams({
      key: config.keys.weather,
      cityname,
      dtype,
      format,
    })

    const upstream = await fetchUpstreamJson(
      `${config.juheWeatherBase}/weather/index?${query.toString()}`,
      { timeoutMs: upstreamTimeout },
    )

    const errorCode = Number(upstream?.error_code ?? upstream?.resultcode ?? 0)
    if (errorCode !== 0) {
      throw new HttpError(502, toString(upstream?.reason) || '天气接口返回异常')
    }

    weatherCache.set(cacheKey, upstream)
    sendData(res, upstream, { 'x-cache': 'miss' })
  }

  /**
   * 替代原先仓库外的 localhost:3000/api/ip。
   * 未配置 JUHE_IP_KEY 时返回空 details，客户端会回退到默认城市，不阻塞天气展示。
   */
  async function ip(req, res) {
    const clientIp = clientIpFor(req)

    const cached = ipCache.get(clientIp)
    if (cached) {
      sendData(res, cached, { 'x-cache': 'hit' })
      return
    }

    let resolved = { ip: clientIp, address: '', details: {} }

    if (config.keys.ip) {
      try {
        const query = new URLSearchParams({ key: config.keys.ip })
        if (!isPrivateIp(clientIp)) {
          query.set('ip', clientIp)
        }
        const upstream = await fetchUpstreamJson(
          `${config.juheIpBase}/ip/ipNewV3?${query.toString()}`,
          { timeoutMs: upstreamTimeout },
        )

        const body = upstream?.result
        if (body && typeof body === 'object') {
          const details = {
            city: toString(body.City),
            regionName: toString(body.Province),
            country: toString(body.Country),
          }
          resolved = {
            ip: toString(body.Ip) || clientIp,
            address: [details.country, details.regionName, details.city].filter(Boolean).join(' '),
            details,
          }
        }
      } catch (error) {
        // 定位是增强能力：失败不报错，交给客户端回退默认城市
        console.warn('[bff] IP 归属地查询失败：', error instanceof Error ? error.message : String(error))
      }
    }

    ipCache.set(clientIp, resolved)
    sendData(res, resolved)
  }

  /**
   * 流式对话：以 SSE 把「思考过程」与「正文」增量推给浏览器。
   * 首个增量到达前不写响应头，这样鉴权/限流等错误仍能用普通 JSON 错误返回。
   */
  async function streamAiChat(req, res, { messages, options }) {
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

      writeEvent('done', {
        ...result,
        elapsedMs: Date.now() - startedAt,
      })
      res.end()
    } catch (error) {
      if (controller.signal.aborted) {
        res.end()
        return
      }

      const status = error instanceof HttpError ? error.status : 502
      const message = error instanceof Error ? error.message : String(error)

      if (!streamStarted) {
        // 响应头未发送，交给上层按统一 JSON 错误返回
        throw error instanceof HttpError ? error : new HttpError(status, message)
      }

      writeEvent('error', { status, message })
      res.end()
    } finally {
      res.off('close', abortUpstream)
    }
  }

  /**
   * 大模型对话：浏览器只发同源 POST，DeepSeek 密钥与上游调用都留在服务端。
   */
  async function aiChat(req, res) {
    const body = await readJsonBody(req, { maxBytes: AI_MAX_BODY_BYTES })
    const { messages, options, stream } = parseAiChatBody(body)

    aiRateLimiter(clientIpFor(req))

    if (stream) {
      await streamAiChat(req, res, { messages, options })
      return
    }

    const startedAt = Date.now()
    const result = await chatCompletion(config.llm, { messages, ...options })

    sendData(res, {
      ...result,
      elapsedMs: Date.now() - startedAt,
    })
  }

  /**
   * 比赛地天气：主队城市由 DeepSeek 解析，天气来自 Open-Meteo。
   * 解析失败返回 available:false，前端会降级为「天气未获取」，不阻塞 AI 分析。
   */
  async function venueWeather(req, res, url) {
    const homeTeam = textParam(url, 'homeTeam')
    if (!homeTeam) {
      throw new HttpError(400, '缺少 homeTeam 参数')
    }

    const league = textParam(url, 'league')
    const kickoff = textParam(url, 'kickoff')
    const teamId = intParam(url, 'teamId', 0, { min: 0, max: Number.MAX_SAFE_INTEGER })

    venueRateLimiter(clientIpFor(req))

    const controller = new AbortController()
    const abortUpstream = () => controller.abort()
    res.on('close', abortUpstream)

    try {
      const data = await venueService.get({
        teamId: teamId || undefined,
        homeTeam,
        league,
        kickoff,
        signal: controller.signal,
      })

      if (controller.signal.aborted || res.destroyed) {
        return
      }

      sendData(res, data)
    } finally {
      res.off('close', abortUpstream)
    }
  }

  function health(_req, res) {
    sendData(res, {
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      upstream: {
        sporttery: config.sportteryBase,
        juheWeb: config.juheWebBase,
        juheWeather: config.juheWeatherBase,
        juheIp: config.juheIpBase,
      },
      llm: {
        baseUrl: config.llm.baseUrl,
        model: config.llm.model,
        thinking: config.llm.thinking,
      },
      keysConfigured: {
        weather: Boolean(config.keys.weather),
        horoscope: Boolean(config.keys.horoscope),
        ip: Boolean(config.keys.ip),
        deepseek: Boolean(config.llm.apiKey),
      },
      cacheSizes: {
        matches: matchCache.size,
        history: historyCache.size,
        horoscope: horoscopeCache.size,
        weather: weatherCache.size,
        ip: ipCache.size,
      },
    })
  }

  return { matches, history, horoscope, weather, ip, aiChat, venueWeather, health }
}
