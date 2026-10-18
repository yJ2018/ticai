import { request } from '../api/httpClient'
import { type BffEnvelope } from '../api/types'
import { type WeatherData, type WeatherForecastItem } from '../domain/weather'

/** 聚合数据天气接口的原始字段（由 BFF 校验 error_code 后原样回传） */
type JuheWeatherPayload = {
  result?: {
    sk?: {
      temp?: string | number
      humidity?: string
      wind_direction?: string
      wind_strength?: string
      time?: string
    }
    today?: {
      city?: string
      date_y?: string
      week?: string
      temperature?: string
      weather?: string
      wind?: string
      dressing_index?: string
      dressing_advice?: string
      uv_index?: string
      travel_index?: string
      exercise_index?: string
      wash_index?: string
    }
    future?: JuheWeatherFutureItem[] | Record<string, JuheWeatherFutureItem>
  }
}

type JuheWeatherFutureItem = {
  date?: string
  week?: string
  temperature?: string
  weather?: string
  wind?: string
}

/** BFF /api/ip 的响应体 */
type LocationPayload = {
  ip: string
  address?: string
  details?: {
    city?: string
    regionName?: string
    country?: string
  }
}

const WEATHER_ENDPOINT = '/api/weather'
const LOCATION_ENDPOINT = '/api/ip'
const DEFAULT_WEATHER_CITY = '宝山'

export const weatherService = {
  async getWeather(cityName: string, signal?: AbortSignal): Promise<WeatherData> {
    return getWeatherByCity(cityName, signal)
  },

  async getWeatherByLocation(signal?: AbortSignal): Promise<WeatherData> {
    const cityName = await resolveCurrentCity(signal).catch(() => DEFAULT_WEATHER_CITY)
    return getWeatherByCity(cityName, signal)
  },
}

async function getWeatherByCity(cityName: string, signal?: AbortSignal) {
  const query = new URLSearchParams({
    cityname: cityName,
    dtype: '',
    format: '',
  })

  const payload = await request<BffEnvelope<JuheWeatherPayload>>(
    `${WEATHER_ENDPOINT}?${query.toString()}`,
    { signal },
  )

  if (!payload.success || !payload.data) {
    throw new Error(payload.errorMessage || '天气接口返回异常')
  }

  if (!payload.data.result) {
    throw new Error('天气数据为空')
  }

  return normalizeWeatherData(cityName, payload.data)
}

async function resolveCurrentCity(signal?: AbortSignal): Promise<string> {
  const payload = await request<BffEnvelope<LocationPayload>>(
    `${LOCATION_ENDPOINT}?_t=${Date.now()}`,
    { signal },
  )

  if (!payload.success || !payload.data) {
    return DEFAULT_WEATHER_CITY
  }

  const details = payload.data.details
  if (details?.city) {
    return normalizeCityName(details.city)
  }

  if (details?.regionName) {
    return normalizeCityName(details.regionName)
  }

  return DEFAULT_WEATHER_CITY
}

function normalizeWeatherData(cityName: string, payload: JuheWeatherPayload): WeatherData {
  const current = payload.result?.sk
  const today = payload.result?.today
  const future = normalizeFuture(payload.result?.future)

  return {
    city: normalizeText(today?.city) === '--' ? cityName : normalizeText(today?.city),
    date: normalizeText(today?.date_y),
    week: normalizeText(today?.week),
    currentTemp: normalizeText(current?.temp, '℃'),
    humidity: normalizeText(current?.humidity),
    windDirection: normalizeText(current?.wind_direction),
    windStrength: normalizeText(current?.wind_strength),
    updateTime: normalizeText(current?.time),
    weather: normalizeText(today?.weather),
    temperatureRange: normalizeText(today?.temperature),
    dressingIndex: normalizeText(today?.dressing_index),
    dressingAdvice: normalizeText(today?.dressing_advice),
    uvIndex: normalizeText(today?.uv_index),
    travelIndex: normalizeText(today?.travel_index),
    exerciseIndex: normalizeText(today?.exercise_index),
    washingIndex: normalizeText(today?.wash_index),
    future: future.slice(0, 4).map(toForecastItem),
  }
}

function normalizeFuture(
  value: JuheWeatherFutureItem[] | Record<string, JuheWeatherFutureItem> | undefined,
): JuheWeatherFutureItem[] {
  if (!value) {
    return []
  }

  if (Array.isArray(value)) {
    return value
  }

  return Object.values(value)
}

function toForecastItem(item: JuheWeatherFutureItem): WeatherForecastItem {
  return {
    date: normalizeText(item?.date),
    week: normalizeText(item?.week),
    temperature: normalizeText(item?.temperature),
    weather: normalizeText(item?.weather),
    wind: normalizeText(item?.wind),
  }
}

function normalizeCityName(value: string | undefined) {
  if (!value) {
    return DEFAULT_WEATHER_CITY
  }

  const normalized = value.trim().replace(/市$/, '')
  return normalized || DEFAULT_WEATHER_CITY
}

function normalizeText(value: string | number | undefined, suffix = '') {
  if (value === undefined || value === null || value === '') {
    return '--'
  }
  return `${String(value)}${suffix}`
}
