import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApp } from './app.mjs'
import { createConfig, loadEnv } from './config.mjs'
import { closePool } from './db.mjs'

/**
 * 本地 / 国内 VPS 入口。Vercel 走 api/index.js，两者共用 createApp()。
 */

const repoRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const envLoaded = loadEnv(repoRoot)
const config = createConfig()
const app = createApp(config)

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
  console.log('  接口                : /api/matches /api/history /api/horoscope /api/weather')
  console.log('                        /api/ip /api/venue-weather /api/ai-chat /api/health')
  console.log('─'.repeat(64))
})

function shutdown(signal) {
  console.log(`\n[api] 收到 ${signal}，正在关闭...`)
  server.close(async () => {
    await closePool()
    process.exit(0)
  })
  server.closeAllConnections?.()
  setTimeout(() => process.exit(0), 3_000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
