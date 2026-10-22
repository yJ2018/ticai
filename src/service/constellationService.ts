import { apiUrl } from '../api/base'
import { request } from '../api/httpClient'
import { type BffEnvelope } from '../api/types'
import { CONSTELLATIONS, type ConstellationName, type HoroscopeData, type HoroscopeType } from '../domain/constellation'

/** 聚合数据星座接口的原始字段（由 BFF 校验 error_code 后原样回传） */
type JuheHoroscopePayload = {
  name?: string
  date?: string
  datetime?: string
  all?: string
  color?: string
  health?: string
  love?: string
  money?: string
  work?: string
  number?: string | number
  qfriend?: string
  QFriend?: string
  summary?: string
}

const HOROSCOPE_ENDPOINT = apiUrl('/api/horoscope')

export const constellationService = {
  async getHoroscope(
    consName: ConstellationName,
    type: HoroscopeType,
    signal?: AbortSignal,
  ): Promise<HoroscopeData> {
    const query = new URLSearchParams({ consName, type })

    const payload = await request<BffEnvelope<JuheHoroscopePayload>>(
      `${HOROSCOPE_ENDPOINT}?${query.toString()}`,
      { signal },
    )

    if (!payload.success || !payload.data) {
      throw new Error(payload.errorMessage || '星座运势接口返回异常')
    }

    return normalizeHoroscopeData(consName, type, payload.data)
  },
}

function normalizeHoroscopeData(
  consName: ConstellationName,
  type: HoroscopeType,
  result: JuheHoroscopePayload,
): HoroscopeData {
  return {
    name: result.name || consName,
    dateRange: getConstellationDateRange(consName),
    datetime: result.datetime || result.date || getTypeLabel(type),
    type,
    all: normalizeText(result.all),
    color: normalizeText(result.color),
    health: normalizeText(result.health),
    love: normalizeText(result.love),
    money: normalizeText(result.money),
    work: normalizeText(result.work),
    number: normalizeText(result.number),
    qFriend: normalizeText(result.qfriend || result.QFriend),
    summary: normalizeText(result.summary),
  }
}

function getConstellationDateRange(consName: ConstellationName) {
  return CONSTELLATIONS.find((item) => item.name === consName)?.dateRange ?? '--'
}

function normalizeText(value: string | number | undefined) {
  if (value === undefined || value === null || value === '') {
    return '--'
  }
  return String(value)
}

function getTypeLabel(type: HoroscopeType) {
  const map: Record<HoroscopeType, string> = {
    today: '今日运势',
    tomorrow: '明日运势',
    week: '本周运势',
    month: '本月运势',
    year: '本年运势',
  }
  return map[type]
}
