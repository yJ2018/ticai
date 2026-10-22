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

    sendData(ctx.res, {
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      db: 'up',
      dataSources: sources,
    })
  }

  return { healthz, health }
}
