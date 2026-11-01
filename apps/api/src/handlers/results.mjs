import { intParam, sendData, textParam } from '../lib.mjs'
import { listResults } from '../repos/results.mjs'

/**
 * 赛果开奖查询。
 *
 *   GET /api/results?period=2026-10-31&limit=500
 *
 * 按期（销售日）取，不按自然日：竞彩按「周X」分期，周六 001–0xx 从周六下午排到周日凌晨，
 * 按日期切会把同一期拆成两天。不传 period 就是最近一期。
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function createResultsHandlers(config) {
  async function results(ctx) {
    const rawPeriod = textParam(ctx.url, 'period', '')
    const limit = intParam(ctx.url, 'limit', 200, { min: 1, max: 500 })

    const period = DATE_PATTERN.test(rawPeriod) && Number.isFinite(Date.parse(`${rawPeriod}T00:00:00Z`))
      ? rawPeriod
      : ''

    const data = await listResults(config, { period, limit })

    sendData(
      ctx.res,
      {
        period: data.period,
        label: data.label,
        count: data.count,
        settled: data.settled,
        updatedAt: data.updatedAt ?? null,
        periods: data.periods,
        items: data.items,
      },
      { 'x-cache': data.cache },
    )
  }

  return { results }
}
