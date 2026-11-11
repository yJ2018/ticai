/**
 * 彩票各彩种的开奖日与「下一期」估算。
 *
 * 只用于「我的投注」把待开奖的同类投注合并成一批：
 * - 排列5 / 快乐8：每日开奖；
 * - 七星彩：周二 / 周五 / 周日；
 * - 大乐透：周一 / 周三 / 周六；
 * - 双色球：周二 / 周四 / 周日。
 *
 * 每期 21:00 左右截止（官方开奖约 21:25）。这里以 21:00 为界：
 * 截止前投注算当天这一期，截止后算下一个开奖日。
 * 这是展示层的批次归并，真实开奖期号仍以官方为准；不参与结算。
 */

const DRAW_WEEKDAYS: Record<string, readonly number[]> = {
  // ISO 星期：周一 1 … 周日 7
  pl5: [1, 2, 3, 4, 5, 6, 7],
  qxc: [2, 5, 7],
  dlt: [1, 3, 6],
  ssq: [2, 4, 7],
  kl8: [1, 2, 3, 4, 5, 6, 7],
}

const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const
const CUTOFF_HOUR = 21

const RULE_LABELS: Record<string, string> = {
  pl5: '每日开奖',
  qxc: '周二 / 周五 / 周日开奖',
  dlt: '周一 / 周三 / 周六开奖',
  ssq: '周二 / 周四 / 周日开奖',
  kl8: '每日开奖',
}

export function getLotteryDrawRuleLabel(gameKey: string): string {
  return RULE_LABELS[gameKey] ?? '按官方开奖日'
}

/**
 * 返回这笔投注预计对应的开奖日（本地时区 YYYY-MM-DD）。
 *
 * 只做「同一天 / 同一批次」归并，不推算具体期号；如果官方临时调整开奖日，
 * 结果可能偏差一天，因此界面文案统一带「预计」。
 */
export function getNextLotteryDrawDate(gameKey: string, placedAt: string | Date): string {
  const date = placedAt instanceof Date ? new Date(placedAt) : new Date(placedAt)
  if (Number.isNaN(date.getTime())) {
    return formatLocalDate(new Date())
  }

  const weekdays = DRAW_WEEKDAYS[gameKey] ?? ALL_WEEKDAYS
  const today = startOfLocalDay(date)
  const afterCutoff = date.getHours() >= CUTOFF_HOUR

  if (!afterCutoff && weekdays.includes(isoWeekday(today))) {
    return formatLocalDate(today)
  }

  for (let offset = 1; offset <= 7; offset += 1) {
    const candidate = addDays(today, offset)
    if (weekdays.includes(isoWeekday(candidate))) {
      return formatLocalDate(candidate)
    }
  }

  return formatLocalDate(today)
}

/** YYYY-MM-DD → MM-DD，给卡片标题用 */
export function formatMonthDay(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  return match ? `${match[2]}-${match[3]}` : isoDate
}

function isoWeekday(date: Date): number {
  const day = date.getDay()
  return day === 0 ? 7 : day
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function addDays(date: Date, offset: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + offset)
  return next
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
