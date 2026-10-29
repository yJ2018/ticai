import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApp } from './app.mjs'
import { createConfig, loadEnv } from './config.mjs'
import { closePool, ping } from './db.mjs'
import { warmGameCache } from './repos/lottery.mjs'

/**
 * 本地 / 国内 VPS 入口。Vercel 走 api/index.js，两者共用 createApp()。
 */

const repoRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const envLoaded = loadEnv(repoRoot)
const config = createConfig()
const app = createApp(config)
let keepAliveTimer = null

const server = createServer((req, res) => {
  app(req, res).catch((error) => {
    console.error('[api] 处理器未捕获异常：', error)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ success: false, errorMessage: '服务内部错误' }))
      return
    }
    res.destroy()
  })
})

server.listen(config.port, config.host, () => {
  const dbReady = config.database.url ? '已配置' : '未配置（数据接口会返回 503）'
  const cors = config.corsOrigins.length > 0 ? config.corsOrigins.join(', ') : '未启用（仅同源）'
  const aiReady = config.llm.apiKey ? '已配置' : '未配置（/api/ai-chat 返回 503）'

  console.log('─'.repeat(64))
  console.log(`ticai API 已启动  http://${config.host}:${config.port}`)
  console.log(`  环境文件            : ${envLoaded ? '已加载' : '未找到'}`)
  console.log(`  数据库              : ${dbReady}`)
  console.log(`  DeepSeek            : ${aiReady} (${config.llm.model})`)
  console.log(`  CORS 允许来源       : ${cors}`)
  console.log(
    `  聚合数据密钥        : 天气${config.juhe.weatherKey ? '✓' : '✗'} ` +
      `星座${config.juhe.horoscopeKey ? '✓' : '✗'} IP${config.juhe.ipKey ? '✓' : '✗'}`,
  )
  console.log('  接口                : /api/matches /api/results /api/history /api/horoscope /api/weather')
  console.log('                        /api/ip /api/venue-weather /api/ai-chat /api/health')
  console.log('                        /api/analysis/lottery（开奖分析快照，开奖后由爬虫预算）')
  console.log('  账号与投注          : /api/auth/code /register /login /password /email /logout /me · /api/bets')
  console.log(
    `  微信登录            : ${config.wechat.appId ? '已配置' : '未配置（前端展示接入步骤）'}`,
  )
  console.log('─'.repeat(64))

  // 启动后立刻建好数据库连接，并预热彩种元数据，避免第一个历史请求替用户等 5–7s 握手
  if (config.database.url) {
    void warmGameCache(config)
      .then((count) => console.log(`[api] 数据库连接已预热，彩种元数据 ${count} 条`))
      .catch((error) => console.warn('[api] 数据库预热失败：', error.message))

    // 用户隔几分钟/几十分钟再来时，不要让连接池把连接关掉；
    // 每 4 分钟 select 1 一次（可用 DATABASE_KEEPALIVE_MS 调整）。
    if (config.database.keepAliveMs > 0) {
      console.log(`[api] 数据库保活已启用（每 ${Math.round(config.database.keepAliveMs / 1000)}s）`)
      keepAliveTimer = setInterval(() => {
        void ping(config).then((ok) => {
          if (!ok) {
            console.warn('[api] 数据库保活失败，下次请求会重新建连')
          }
        })
      }, config.database.keepAliveMs)
      keepAliveTimer.unref?.()
    }
  }
})

function shutdown(signal) {
  console.log(`\n[api] 收到 ${signal}，正在关闭...`)
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer)
    keepAliveTimer = null
  }
  server.close(async () => {
    await closePool()
    process.exit(0)
  })
  server.closeAllConnections?.()
  setTimeout(() => process.exit(0), 3_000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
