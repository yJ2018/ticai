/**
 * 每日固定时刻调度（北京时间）。
 *
 * 竞彩 11:00 开盘，9:00 预热一轮能保证开盘时库里已经是当天赛程。
 * 中国不使用夏令时，按固定 +08:00 计算即可，不需要 tz 数据库。
 */

function beijingParts(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  return { hour: pick('hour'), minute: pick('minute'), second: pick('second') }
}

/**
 * 距离下一个「北京时间 hour:minute」还有多少毫秒。
 * 今天已过则顺延到明天。
 */
export function msUntilNextDaily(hour, minute = 0, now = new Date()) {
  const clock = beijingParts(now)
  const nowSeconds = clock.hour * 3600 + clock.minute * 60 + clock.second
  const targetSeconds = hour * 3600 + minute * 60
  let delta = targetSeconds - nowSeconds
  if (delta <= 0) {
    delta += 86_400
  }
  return delta * 1_000
}
