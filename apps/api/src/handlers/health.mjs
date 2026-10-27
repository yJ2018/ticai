import { ping, query } from '../db.mjs'
import { sendData, sendError } from '../lib.mjs'

/**
 * 健康检查拆成两个：
 *   /healthz     仅表示进程活着（liveness），永远 200
 *   /api/health  带上数据库与数据新鲜度（readiness），库不通返回 503
 *
 * 注意不要在这里吐上游地址、模型名或"哪些密钥已配置"——公网上属于侦察信息。
 */

const FRESHNESS_SQL = `
  select source, max(finished_at) as last_ok
  from crawl_run
  where status = 'ok'
  group by source
  order by source
`

/**
 * 分析快照新鲜度：分析是否还停在上一期开奖。
 * 视图随迁移 0007 一起建；旧库没这个视图时只告警，不影响健康检查。
 */
const ANALYSIS_SQL = `
  select
    count(*)::int                                         as total,
    count(*) filter (where latest_issue_seq > through_issue_seq)::int as stale,
    max(computed_at)                                      as last_computed_at
  from lottery_analysis_latest
`

export function createHealthHandlers(config) {
  function healthz(_ctx) {
    // 由 app 直接返回 200
  }

  async function health(ctx) {
    const dbUp = await ping(config)

    if (!dbUp) {
      sendError(ctx.res, 503, '数据库不可用', { 'x-request-id': ctx.requestId })
      return
    }

    let sources = []
    try {
      const { rows } = await query(config, FRESHNESS_SQL)
      const now = Date.now()
      sources = rows.map((row) => ({
        source: row.source,
        lastOkAt: row.last_ok ? new Date(row.last_ok).toISOString() : null,
        ageSeconds: row.last_ok ? Math.round((now - new Date(row.last_ok).getTime()) / 1000) : null,
      }))
    } catch (error) {
      console.warn('[api] 读取数据新鲜度失败：', error instanceof Error ? error.message : String(error))
    }

    let analysis = null
    try {
      const { rows } = await query(config, ANALYSIS_SQL)
      const row = rows[0] ?? {}
      analysis = {
        total: Number(row.total ?? 0),
        stale: Number(row.stale ?? 0),
        lastComputedAt: row.last_computed_at ? new Date(row.last_computed_at).toISOString() : null,
      }
    } catch (error) {
      console.warn('[api] 读取分析快照失败：', error instanceof Error ? error.message : String(error))
    }

    sendData(ctx.res, {
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      db: 'up',
      dataSources: sources,
      analysis,
    })
  }

  return { healthz, health }
}
