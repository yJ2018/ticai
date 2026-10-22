import {
  HttpError,
  clientIpFor,
  createRateLimiter,
  createTtlCache,
  fetchUpstreamJson,
  intParam,
  isPrivateIp,
  sendData,
  textParam,
} from '../lib.mjs'
import { createVenueWeatherService } from '../venue.mjs'

/** 聚合数据（天气/星座/IP）与比赛地天气：纯代理，不落库。 */

const CONSTELLATIONS = new Set([
  '白羊座', '金牛座', '双子座', '巨蟹座', '狮子座', '处女座',
  '天秤座', '天蝎座', '射手座', '摩羯座', '水瓶座', '双鱼座',
])

const HOROSCOPE_TYPES = new Set(['today', 'tomorrow', 'week', 'month', 'year'])

const TRUST_PROXY = process.env.TRUST_PROXY !== '0'

function toString(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

export function createUpstreamHandlers(config) {
  const horoscopeCache = createTtlCache({ ttlMs: 10 * 60_000, maxEntries: 120 })
  const weatherCache = createTtlCache({ ttlMs: 10 * 60_000, maxEntries: 200 })
  const ipCache = createTtlCache({ ttlMs: 30 * 60_000, maxEntries: 500 })

  const venueRateLimiter = createRateLimiter({ limit: config.rateLimit.venuePerMinute })
  const venueService = createVenueWeatherService(config)

  async function horoscope(ctx) {
    const consName = textParam(ctx.url, 'consName')
    if (!CONSTELLATIONS.has(consName)) {
      throw new HttpError(400, 'consName 参数不合法')
    }

    const type = textParam(ctx.url, 'type', 'today') || 'today'
    if (!HOROSCOPE_TYPES.has(type)) {
      throw new HttpError(400, 'type 参数不合法')
    }
    if (!config.juhe.horoscopeKey) {
      throw new HttpError(503, '服务端未配置 JUHE_HOROSCOPE_KEY')
    }

    const cacheKey = `${consName}|${type}`
    const cached = horoscopeCache.get(cacheKey)
    if (cached) {
      sendData(ctx.res, cached, { 'x-cache': 'hit' })
      return
    }

    const query = new URLSearchParams({ key: config.juhe.horoscopeKey, consName, type })
    const upstream = await fetchUpstreamJson(
      `${config.juhe.webBase}/constellation/getAll?${query.toString()}`,
      { timeoutMs: config.timeoutMs },
    )

    const errorCode = Number(upstream?.error_code ?? upstream?.resultcode ?? 0)
    if (errorCode !== 0) {
      throw new HttpError(502, toString(upstream?.reason) || '星座运势接口返回异常')
    }

    horoscopeCache.set(cacheKey, upstream)
    sendData(ctx.res, upstream, { 'x-cache': 'miss' })
  }

  async function weather(ctx) {
    const cityname = textParam(ctx.url, 'cityname')
    if (!cityname) {
      throw new HttpError(400, '缺少 cityname 参数')
    }
    if (!config.juhe.weatherKey) {
      throw new HttpError(503, '服务端未配置 JUHE_WEATHER_KEY')
    }

    const dtype = textParam(ctx.url, 'dtype')
    const format = textParam(ctx.url, 'format')
    const cacheKey = `${cityname}|${dtype}|${format}`
    const cached = weatherCache.get(cacheKey)
    if (cached) {
      sendData(ctx.res, cached, { 'x-cache': 'hit' })
      return
    }

    const query = new URLSearchParams({ key: config.juhe.weatherKey, cityname, dtype, format })
    const upstream = await fetchUpstreamJson(
      `${config.juhe.weatherBase}/weather/index?${query.toString()}`,
      { timeoutMs: config.timeoutMs },
    )

    const errorCode = Number(upstream?.error_code ?? upstream?.resultcode ?? 0)
    if (errorCode !== 0) {
      throw new HttpError(502, toString(upstream?.reason) || '天气接口返回异常')
    }

    weatherCache.set(cacheKey, upstream)
    sendData(ctx.res, upstream, { 'x-cache': 'miss' })
  }

  /** 未配置密钥时返回空 details，客户端回退默认城市，不阻塞天气展示。 */
  async function ip(ctx) {
    const clientIp = clientIpFor(ctx.req, { trustProxy: TRUST_PROXY })

    const cached = ipCache.get(clientIp)
    if (cached) {
      sendData(ctx.res, cached, { 'x-cache': 'hit' })
      return
    }

    let resolved = { ip: clientIp, address: '', details: {} }

    if (config.juhe.ipKey) {
      try {
        const query = new URLSearchParams({ key: config.juhe.ipKey })
        if (!isPrivateIp(clientIp)) {
          query.set('ip', clientIp)
        }
        const upstream = await fetchUpstreamJson(
          `${config.juhe.ipBase}/ip/ipNewV3?${query.toString()}`,
          { timeoutMs: config.timeoutMs },
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
        console.warn('[api] IP 归属地查询失败：', error instanceof Error ? error.message : String(error))
      }
    }

    ipCache.set(clientIp, resolved)
    sendData(ctx.res, resolved)
  }

  /** 比赛地天气：DeepSeek 解析主队城市 + Open-Meteo 取天气。 */
  async function venueWeather(ctx) {
    const homeTeam = textParam(ctx.url, 'homeTeam')
    if (!homeTeam) {
      throw new HttpError(400, '缺少 homeTeam 参数')
    }

    const league = textParam(ctx.url, 'league')
    const kickoff = textParam(ctx.url, 'kickoff')
    const teamId = intParam(ctx.url, 'teamId', 0, { min: 0, max: Number.MAX_SAFE_INTEGER })

    venueRateLimiter(clientIpFor(ctx.req, { trustProxy: TRUST_PROXY }))

    const controller = new AbortController()
    const abortUpstream = () => controller.abort()
    ctx.res.on('close', abortUpstream)

    try {
      const data = await venueService.get({
        teamId: teamId || undefined,
        homeTeam,
        league,
        kickoff,
        signal: controller.signal,
      })

      if (controller.signal.aborted || ctx.res.destroyed) {
        return
      }

      sendData(ctx.res, data)
    } finally {
      ctx.res.off('close', abortUpstream)
    }
  }

  return { horoscope, weather, ip, venueWeather }
}
