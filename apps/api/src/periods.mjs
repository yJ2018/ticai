/**
 * 竞彩「期」相关的小工具。
 *
 * 竞彩按「周X」分期：周六 001–0xx 从周六下午一直排到周日凌晨，
 * 按自然日筛选会把同一期拆成两天，所以赛果页按 `match.business_date`（销售日）分组。
 * 这里只放不依赖数据库的纯函数；SQL 侧的期表达式见 `repos/results.mjs`。
 */

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** '2026-10-31' → '周六'；非法输入返回空串。 */
export function weekdayLabel(date) {
  const text = String(date ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return ''
  }
  const stamp = Date.parse(`${text}T00:00:00Z`)
  if (!Number.isFinite(stamp)) {
    return ''
  }
  return WEEKDAY_LABELS[new Date(stamp).getUTCDay()] ?? ''
}

/** 期号展示：'2026-10-31' → '周六 10-31'；非法输入原样返回。 */
export function periodLabel(date) {
  const text = String(date ?? '').trim()
  const weekday = weekdayLabel(text)
  return weekday ? `${weekday} ${text.slice(5)}` : text
}
