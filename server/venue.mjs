import { createTtlCache, env, stripTrailingSlash } from './lib.mjs'
import { chatCompletion } from './llm.mjs'

/**
 * 比赛地天气。
 *
 * 体彩接口没有场地/城市字段，所以这里分两步：
 * 1. 让 DeepSeek 根据「主队中文名 + 联赛」给出主队所在城市的拉丁名（JSON，低温度）；
 * 2. 用 Open-Meteo 的免费 Geocoding + Forecast API 取该城市当前天气和开赛时段预报。
 *
 * 城市解析结果按球队缓存 7 天，天气按坐标 + 开赛小时缓存 20 分钟；
 * 解析失败会短暂缓存，避免反复消耗模型额度。
 */

const DEFAULT_GEOCODING_BASE = 'https://geocoding-api.open-meteo.com'
const DEFAULT_FORECAST_BASE = 'https://api.open-meteo.com'

const WEATHER_TEXT = {
  0: '晴',
  1: '大部晴朗',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '强阵雪',
  95: '雷暴',
  96: '雷暴伴小冰雹',
  99: '雷暴伴大冰雹',
}

const COUNTRY_ALIASES = new Map([
  ['uk', 'united kingdom'],
  ['great britain', 'united kingdom'],
  ['usa', 'united states'],
  ['us', 'united states'],
  ['uae', 'united arab emirates'],
  ['south korea', 'korea'],
  ['north korea', 'korea'],
  ['czech republic', 'czechia'],
  ['turkey', 'turkiye'],
])

const SYSTEM_PROMPT = `你是足球地理信息助手。根据中国竞彩的主队中文名和联赛名，判断该队主场所在城市。
只输出 json，不要输出解释或 Markdown：
{"city":"城市拉丁名","country":"国家英文名","stadium":"球场名或空字符串","confidence":"high|medium|low"}
要求：
- city 必须是当地语言的拉丁化名称，用于地理编码，例如 帕尔马→Parma、代格福什→Degerfors、热刺→London；
- country 使用常见英文名，例如 Italy、Sweden、England；
- 不确定时 confidence 填 low，不要编造；
- 球场名不确定时填空字符串。`

function weatherText(code) {
  return WEATHER_TEXT[code] ?? '未知天气'
}

function round(value, digits = 1) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return null
  }
  const factor = 10 ** digits
  return Math.round(number * factor) / factor
}

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function countryMatches(result, wanted) {
  if (!wanted) {
    return true
  }

  const target = COUNTRY_ALIASES.get(wanted) ?? wanted
  const country = normalize(result.country)
  const code = normalize(result.country_code)
  const admin = normalize(result.admin1)

  return (
    country === target ||
    code === target ||
    admin === target ||
    country.includes(target) ||
    target.includes(country)
  )
}

function parseBeijingKickoff(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(value ?? '').trim())
  if (!match) {
    return null
  }
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]) - 8,
    Number(match[5]),
  )
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'ticai-bff/1.0',
    },
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  return response.json()
}

function pickGeocodeResult(results, wantedCountry) {
  if (!Array.isArray(results) || results.length === 0) {
    return null
  }

  const candidates = results.filter((result) => countryMatches(result, wantedCountry))
  if (candidates.length === 0) {
    return null
  }

  return candidates.sort((a, b) => (Number(b.population) || 0) - (Number(a.population) || 0))[0]
}

function buildKickoffForecast(payload, kickoff) {
  const epoch = parseBeijingKickoff(kickoff)
  if (!epoch || !Array.isArray(payload?.hourly?.time)) {
    return null
  }

  const offset = Number(payload.utc_offset_seconds)
  if (!Number.isFinite(offset)) {
    return null
  }

  // 把北京时间换算成场地当地的开赛时间，再和 hourly.time（当地 ISO 字符串）对齐
  const localKickoff = new Date(epoch + offset * 1000).toISOString().slice(0, 16)
  const hourKey = localKickoff.slice(0, 13)
  const index = payload.hourly.time.findIndex(
    (time) => typeof time === 'string' && time.slice(0, 13) === hourKey,
  )

  if (index < 0) {
    return null
  }

  return {
    // 实际开赛的当地时间（分钟精度）；天气取同一小时的预报
    time: localKickoff,
    forecastTime: payload.hourly.time[index],
    temperature: round(payload.hourly.temperature_2m?.[index]),
    precipitationProbability: round(payload.hourly.precipitation_probability?.[index], 0),
    weather: weatherText(payload.hourly.weather_code?.[index]),
    windSpeed: round(payload.hourly.wind_speed_10m?.[index]),
  }
}

export function createVenueWeatherService(config) {
  const geocodingBase = stripTrailingSlash(
    env('OPEN_METEO_GEOCODING_BASE', DEFAULT_GEOCODING_BASE),
  )
  const forecastBase = stripTrailingSlash(env('OPEN_METEO_FORECAST_BASE', DEFAULT_FORECAST_BASE))

  const venueCache = createTtlCache({ ttlMs: 7 * 24 * 60 * 60_000, maxEntries: 500 })
  const venueMissCache = createTtlCache({ ttlMs: 10 * 60_000, maxEntries: 500 })
  const weatherCache = createTtlCache({ ttlMs: 20 * 60_000, maxEntries: 500 })
  // 城市解析只是天气的前置步骤，不该让用户等满整段大模型超时
  const resolverLlmConfig = {
    ...config.llm,
    timeoutMs: Math.min(config.llm.timeoutMs, 15_000),
  }

  async function askModel(homeTeam, league, signal) {
    if (!config.llm.apiKey) {
      return null
    }

    const result = await chatCompletion(resolverLlmConfig, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `主队：${homeTeam}\n联赛：${league || '未知'}` },
      ],
      json: true,
      thinking: false,
      maxTokens: 200,
      temperature: 0,
      signal,
    })

    const text = result.content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return null
    }

    if (!parsed || typeof parsed.city !== 'string') {
      return null
    }

    const city = parsed.city.trim()
    const country = typeof parsed.country === 'string' ? parsed.country.trim() : ''
    const confidence = typeof parsed.confidence === 'string' ? parsed.confidence : ''

    if (!/^[\p{Script=Latin}\p{M}\s.'()-]{2,80}$/u.test(city)) {
      return null
    }
    if (confidence === 'low') {
      return null
    }

    return {
      city,
      country,
      stadium: typeof parsed.stadium === 'string' ? parsed.stadium.trim().slice(0, 120) : '',
      confidence,
    }
  }

  async function geocode(city, country) {
    const query = new URLSearchParams({
      name: city,
      count: '10',
      language: 'en',
      format: 'json',
    })

    const payload = await fetchJson(`${geocodingBase}/v1/search?${query.toString()}`, 8_000)
    const result = pickGeocodeResult(payload?.results, normalize(country))

    if (!result) {
      return null
    }

    return {
      city: result.name,
      country: result.country,
      countryCode: result.country_code,
      latitude: result.latitude,
      longitude: result.longitude,
      timezone: result.timezone ?? '',
    }
  }

  async function resolveVenue(homeTeam, league, signal) {
    if (!config.llm.apiKey) {
      return null
    }

    const resolution = await askModel(homeTeam, league, signal)
    if (!resolution) {
      return null
    }

    const location = await geocode(resolution.city, resolution.country)
    if (!location) {
      return null
    }

    return {
      ...location,
      stadium: resolution.stadium,
      confidence: resolution.confidence,
    }
  }

  async function fetchForecast(venue, kickoff) {
    const query = new URLSearchParams({
      latitude: String(venue.latitude),
      longitude: String(venue.longitude),
      current:
        'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      hourly: 'temperature_2m,precipitation_probability,weather_code,wind_speed_10m',
      timezone: 'auto',
      forecast_days: '16',
    })

    const payload = await fetchJson(`${forecastBase}/v1/forecast?${query.toString()}`, 12_000)

    const daily = (payload?.daily?.time ?? []).slice(0, 3).map((date, index) => ({
      date,
      weather: weatherText(payload.daily.weather_code?.[index]),
      tempMax: round(payload.daily.temperature_2m_max?.[index]),
      tempMin: round(payload.daily.temperature_2m_min?.[index]),
      precipitationProbability: round(
        payload.daily.precipitation_probability_max?.[index],
        0,
      ),
    }))

    return {
      timezone: payload?.timezone || venue.timezone || '',
      current: {
        temperature: round(payload?.current?.temperature_2m),
        apparentTemperature: round(payload?.current?.apparent_temperature),
        humidity: round(payload?.current?.relative_humidity_2m, 0),
        precipitation: round(payload?.current?.precipitation),
        windSpeed: round(payload?.current?.wind_speed_10m),
        windDirection: round(payload?.current?.wind_direction_10m, 0),
        weather: weatherText(payload?.current?.weather_code),
        weatherCode: payload?.current?.weather_code ?? null,
        time: payload?.current?.time ?? '',
      },
      daily,
      kickoff: buildKickoffForecast(payload, kickoff),
      source: 'open-meteo',
    }
  }

  async function get({ teamId, homeTeam, league, kickoff, signal }) {
    if (!homeTeam) {
      return { available: false, reason: '缺少主队名称' }
    }
    if (signal?.aborted) {
      return { available: false, reason: '请求已取消' }
    }

    const venueKey = teamId ? `id:${teamId}` : `name:${homeTeam}`
    let venue = venueCache.get(venueKey)

    if (venue === undefined) {
      const missReason = venueMissCache.get(venueKey)
      if (missReason) {
        return { available: false, reason: missReason }
      }

      try {
        venue = await resolveVenue(homeTeam, league, signal)
      } catch (error) {
        if (signal?.aborted) {
          return { available: false, reason: '请求已取消' }
        }
        console.warn(
          '[venue] 城市解析失败：',
          error instanceof Error ? error.message : String(error),
        )
        return { available: false, reason: '比赛地天气服务暂时不可用' }
      }

      if (!venue) {
        const reason = config.llm.apiKey
          ? '无法确认主队所在城市'
          : '服务端未配置 DEEPSEEK_API_KEY，无法解析比赛地'
        venueMissCache.set(venueKey, reason)
        return { available: false, reason }
      }

      venueCache.set(venueKey, venue)
    }

    const weatherKey = `${venue.latitude.toFixed(2)},${venue.longitude.toFixed(2)},${String(
      kickoff ?? '',
    ).slice(0, 13)}`
    let weather = weatherCache.get(weatherKey)

    if (!weather) {
      try {
        weather = await fetchForecast(venue, kickoff)
      } catch (error) {
        console.warn(
          '[venue] 天气获取失败：',
          error instanceof Error ? error.message : String(error),
        )
        return { available: false, reason: '比赛地天气获取失败' }
      }
      weatherCache.set(weatherKey, weather)
    }

    return {
      available: true,
      ...venue,
      ...weather,
    }
  }

  return { get }
}
