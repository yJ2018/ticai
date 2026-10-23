/**
 * 竞彩销售时段判断。
 *
 * 体彩竞彩的销售时间（北京时间）：
 *   周一~周五 11:00–22:00
 *   周六~周日 11:00–23:00
 * 单场比赛在开赛时停售。
 *
 * 非销售时段上游数据也不会变（盘口关了），继续抓只是白跑，
 * 所以 matches / lineups / details 三条链路都要过这个闸门；开奖不受影响。
 *
 * 时段可通过环境变量覆盖：
 *   BET_WINDOW_WEEKDAY=11:00-22:00
 *   BET_WINDOW_WEEKEND=11:00-23:00
 */

function parseClock(text) {
  const matched = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (!matched) {
    return null
  }
  const hour = Number(matched[1])
  const minute = Number(matched[2])
  if (hour > 24 || minute > 59) {
    return null
  }
  return hour * 60 + minute
}

export function parseWindow(text) {
  const [start, end] = String(text ?? '').split('-')
  const startMinutes = parseClock(start)
  const endMinutes = parseClock(end)
  if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
    return null
  }
  return { start: startMinutes, end: endMinutes }
}

/** 北京时间的 ISO 星期（1=周一 … 7=周日）与当天分钟数。 */
export function beijingClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? ''
  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
  const isoWeekday = weekdayMap[pick('weekday')] ?? 1
  return {
    isoWeekday,
    minutes: Number(pick('hour')) * 60 + Number(pick('minute')),
    label: `${pick('hour')}:${pick('minute')}`,
  }
}

export function isBettingOpen(now, config) {
  const weekday = parseWindow(config.betWindowWeekday) ?? { start: 11 * 60, end: 22 * 60 }
  const weekend = parseWindow(config.betWindowWeekend) ?? { start: 11 * 60, end: 23 * 60 }
  const clock = beijingClock(now)
  const window = clock.isoWeekday >= 6 ? weekend : weekday
  return {
    open: clock.minutes >= window.start && clock.minutes < window.end,
    clock,
    window,
  }
}

/**
 * 距离下一次开盘还有多少毫秒。
 *
 * 用来在停售时段排一个一次性定时器：一到开盘就立刻跑一轮，
 * 不用等下一个 30 分钟周期——否则 10:58 跳过、11:28 才抓，开盘后半小时都是旧数据。
 */
export function msUntilWindowOpen(now, config) {
  const weekday = parseWindow(config.betWindowWeekday) ?? { start: 11 * 60, end: 22 * 60 }
  const weekend = parseWindow(config.betWindowWeekend) ?? { start: 11 * 60, end: 23 * 60 }
  const clock = beijingClock(now)
  const window = clock.isoWeekday >= 6 ? weekend : weekday

  if (clock.minutes < window.start) {
    return (window.start - clock.minutes) * 60_000
  }
  // 今天已开盘（或已收盘）：等到明天开盘
  return (24 * 60 - clock.minutes + window.start) * 60_000
}

export function formatClock(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}
