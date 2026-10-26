import { intParam, sendData, textParam } from '../lib.mjs'
import { listResults } from '../repos/results.mjs'

/**
 * 赛果开奖查询。
 *
 *   GET /api/results?date=2026-10-25&days=3&limit=200
 *
 * 不传 date 就是今天（北京时间）；days=3 表示从 date 往前数 3 天（含当天）。
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function shanghaiToday(now = new Date()) {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export function addDays(date, offset) {
  const stamp = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(stamp)) {
    return date
  }
  return new Date(stamp + offset * 86_400_000).toISOString().slice(0, 10)
}

export function createResultsHandlers(config) {
  async function results(ctx) {
    const rawDate = textParam(ctx.url, 'date', '')
    const days = intParam(ctx.url, 'days', 3, { min: 1, max: 30 })
    const limit = intParam(ctx.url, 'limit', 200, { min: 1, max: 500 })

    const anchor = DATE_PATTERN.test(rawDate) && Number.isFinite(Date.parse(`${rawDate}T00:00:00Z`))
      ? rawDate
      : shanghaiToday()

    const from = addDays(anchor, -(days - 1))
    const to = anchor
    const { items, updatedAt, cache } = await listResults(config, { from, to, limit })

    sendData(
      ctx.res,
      {
        from,
        to,
        updatedAt: updatedAt ?? null,
        count: items.length,
        items,
      },
      { 'x-cache': cache },
    )
  }

  return { results }
}
