import { apiUrl } from './base'
import { request } from './httpClient'
import { type BffEnvelope } from './types'

/** 比赛地天气（Open-Meteo 预报，由 BFF 解析主队城市后返回） */
export type VenueWeatherCurrent = {
  temperature: number | null
  apparentTemperature: number | null
  humidity: number | null
  precipitation: number | null
  windSpeed: number | null
  windDirection: number | null
  weather: string
  weatherCode: number | null
  time: string
}

export type VenueWeatherDaily = {
  date: string
  weather: string
  tempMax: number | null
  tempMin: number | null
  precipitationProbability: number | null
}

export type VenueWeatherKickoff = {
  time: string
  temperature: number | null
  precipitationProbability: number | null
  weather: string
  windSpeed: number | null
}

export type VenueWeatherData = {
  available: true
  city: string
  country: string
  countryCode?: string
  stadium?: string
  confidence?: string
  latitude: number
  longitude: number
  timezone: string
  current: VenueWeatherCurrent
  daily: VenueWeatherDaily[]
  kickoff: VenueWeatherKickoff | null
  source: string
}

export type VenueWeatherUnavailable = {
  available: false
  reason: string
}

export type VenueWeatherResult = VenueWeatherData | VenueWeatherUnavailable

export type VenueWeatherQuery = {
  teamId?: number
  homeTeam: string
  league: string
  kickoff: string
}

const VENUE_WEATHER_ENDPOINT = apiUrl('/api/venue-weather')

export async function getVenueWeather(
  query: VenueWeatherQuery,
  signal?: AbortSignal,
): Promise<VenueWeatherResult> {
  const params = new URLSearchParams({
    homeTeam: query.homeTeam,
    league: query.league,
    kickoff: query.kickoff,
  })

  if (query.teamId) {
    params.set('teamId', String(query.teamId))
  }

  const payload = await request<BffEnvelope<VenueWeatherResult>>(
    `${VENUE_WEATHER_ENDPOINT}?${params.toString()}`,
    { signal, timeoutMs: 30_000 },
  )

  if (!payload.success || !payload.data) {
    throw new Error(payload.errorMessage || '比赛地天气接口返回异常')
  }

  return payload.data
}
