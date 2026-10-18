export const CONSTELLATIONS = [
  { name: '白羊座', dateRange: '3.21 - 4.19' },
  { name: '金牛座', dateRange: '4.20 - 5.20' },
  { name: '双子座', dateRange: '5.21 - 6.21' },
  { name: '巨蟹座', dateRange: '6.22 - 7.22' },
  { name: '狮子座', dateRange: '7.23 - 8.22' },
  { name: '处女座', dateRange: '8.23 - 9.22' },
  { name: '天秤座', dateRange: '9.23 - 10.23' },
  { name: '天蝎座', dateRange: '10.24 - 11.22' },
  { name: '射手座', dateRange: '11.23 - 12.21' },
  { name: '摩羯座', dateRange: '12.22 - 1.19' },
  { name: '水瓶座', dateRange: '1.20 - 2.18' },
  { name: '双鱼座', dateRange: '2.19 - 3.20' },
] as const

export const HOROSCOPE_TYPES = [
  { key: 'today', label: '今日' },
  { key: 'tomorrow', label: '明日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'year', label: '本年' },
] as const

export type ConstellationName = (typeof CONSTELLATIONS)[number]['name']
export type HoroscopeType = (typeof HOROSCOPE_TYPES)[number]['key']

export type HoroscopeData = {
  name: string
  dateRange: string
  datetime: string
  type: HoroscopeType
  all: string
  color: string
  health: string
  love: string
  money: string
  work: string
  number: string
  qFriend: string
  summary: string
}
