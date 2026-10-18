import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { createApiConfig, createHandlers } from './handlers.mjs'
import { HttpError, env, loadEnvFile, logRequest, sendError, tryServeStatic } from './lib.mjs'

const envLoaded = loadEnvFile()

const PORT = Number(env('PORT', '3000'))
const HOST = env('HOST', '127.0.0.1')
const SERVE_STATIC = env('SERVE_STATIC', '1') !== '0'
const staticRoot = resolve(process.cwd(), 'dist')
const staticEnabled = SERVE_STATIC && existsSync(staticRoot)

const config = createApiConfig()
const handlers = createHandlers(config)

const ROUTES = new Map([
  ['/api/matches', handlers.matches],
  ['/api/history', handlers.history],
  ['/api/horoscope', handlers.horoscope],
  ['/api/weather', handlers.weather],
  ['/api/ip', handlers.ip],
  ['/api/health', handlers.health],
])

function sendMethodNotAllowed(res, allow = 'GET') {
  res.writeHead(405, {
    'content-type': 'application/json; charset=utf-8',
    allow,
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify({ success: false, errorMessage: `不支持的方法，仅允许 ${allow}` }))
}

function serveAppShell(res) {
  if (!staticEnabled) {
    sendError(
      res,
      503,
      '静态资源未构建：请先执行 npm run build，或使用 npm run dev 启动开发环境',
    )
    return
  }

  if (tryServeStatic(staticRoot, '/index.html', { method: 'GET' }, res)) {
    return
  }

  sendError(res, 500, 'index.html 缺失')
}

const server = createServer(async (req, res) => {
  const startedAt = Date.now()
  let url
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  } catch {
    sendError(res, 400, '非法的请求地址')
    return
  }

  const pathname = url.pathname

  res.on('finish', () => {
    logRequest(req.method ?? 'GET', pathname, res.statusCode, startedAt)
  })

  try {
    if (pathname.startsWith('/api/')) {
      const handler = ROUTES.get(pathname)
      if (!handler) {
        sendError(res, 404, '接口不存在')
        return
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendMethodNotAllowed(res, 'GET')
        return
      }

      await handler(req, res, url)
      return
    }

    if (staticEnabled && tryServeStatic(staticRoot, pathname, req, res)) {
      return
    }

    const acceptsHtml = (req.headers.accept ?? '').includes('text/html')
    // 前端路由没有扩展名（/history），静态资源有（/x.png）。
    // 这样既能支持刷新深层链接，也不会把"缺失的图片"伪装成 200 HTML。
    const lastSegment = pathname.split('/').pop() ?? ''
    const looksLikeRoute = !lastSegment.includes('.')
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      (pathname === '/' || acceptsHtml || looksLikeRoute)
    ) {
      serveAppShell(res)
      return
    }

    sendError(res, 404, '资源不存在')
  } catch (error) {
    if (res.headersSent) {
      res.destroy()
      return
    }

    if (error instanceof HttpError) {
      sendError(res, error.status, error.message)
      return
    }

    console.error('[bff] 未处理异常：', error)
    sendError(res, 500, '服务内部错误')
  }
})

server.listen(PORT, HOST, () => {
  const flags = [
    config.keys.weather ? '天气✓' : '天气✗',
    config.keys.horoscope ? '星座✓' : '星座✗',
    config.keys.ip ? 'IP定位✓' : 'IP定位✗',
  ].join('  ')

  console.log('─'.repeat(64))
  console.log(`ticai BFF 已启动  http://${HOST}:${PORT}`)
  console.log(`  环境文件 .env        : ${envLoaded ? '已加载' : '未找到（使用默认值）'}`)
  console.log(`  上游 体彩            : ${config.sportteryBase}`)
  console.log(`  上游 聚合数据         : ${config.juheWebBase}`)
  console.log(`  密钥状态             : ${flags}`)
  console.log(`  静态资源 dist        : ${staticEnabled ? '已启用（同源部署）' : '未启用'}`)
  console.log(`  接口                 : /api/matches /api/history /api/horoscope /api/weather /api/ip /api/health`)
  console.log('─'.repeat(64))
})

function shutdown(signal) {
  console.log(`\n[bff] 收到 ${signal}，正在关闭...`)
  server.close(() => process.exit(0))
  server.closeAllConnections?.()
  setTimeout(() => process.exit(0), 3_000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
