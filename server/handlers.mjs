import {
  HttpError,
  createTtlCache,
  env,
  envInt,
  fetchUpstreamJson,
  sendData,
  sendJson,
  stripTrailingSlash,
} from './lib.mjs'

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

export function createHandlers(config) {
  const matchCache = createTtlCache({ ttlMs: 20_000, maxEntries: 10 })
  const historyCache = createTtlCache({ ttlMs: 60_000, maxEntries: 200 })
  const horoscopeCache = createTtlCache({ ttlMs: 10 * 60_000, maxEntries: 120 })
  const weatherCache = createTtlCache({ ttlMs: 10 * 60_000, maxEntries: 200 })
  const ipCache = createTtlCache({ ttlMs: 30 * 60_000, maxEntries: 500 })
  const upstreamTimeout = config.timeoutMs

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
    const forwarded = req.headers['x-forwarded-for']
    const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : (forwarded ?? '')
    const rawIp = firstForwarded.split(',')[0].trim() || req.socket.remoteAddress || ''
    const clientIp = rawIp.replace(/^::ffff:/, '')

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
      keysConfigured: {
        weather: Boolean(config.keys.weather),
        horoscope: Boolean(config.keys.horoscope),
        ip: Boolean(config.keys.ip),
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

  return { matches, history, horoscope, weather, ip, health }
}
