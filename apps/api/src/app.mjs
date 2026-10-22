import { randomUUID } from 'node:crypto'

import { HttpError, logRequest, sendError, sendJson } from './lib.mjs'
import { createAiHandlers } from './handlers/ai.mjs'
import { createAnalysisHandler } from './handlers/analysis.mjs'
import { createHealthHandlers } from './handlers/health.mjs'
import { createMatchDetailHandler } from './handlers/match-detail.mjs'
import { createSportteryHandlers } from './handlers/sporttery.mjs'
import { createUpstreamHandlers } from './handlers/upstream.mjs'

/**
 * 应用装配：返回一个与框架无关的 `(req, res)` 处理器。
 *
 * 同一份处理器同时给三种宿主使用：
 *   - 本地 / 国内 VPS：src/index.mjs 用 node:http 监听；
 *   - Vercel：api/index.js 作为 serverless 入口导出；
 *   - 单测：直接构造 req/res 断言。
 */

function buildCorsHeaders(req, config) {
  const origin = req.headers.origin
  if (!origin || config.corsOrigins.length === 0) {
    return {}
  }
  if (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,accept',
      'access-control-max-age': '86400',
      vary: 'Origin',
    }
  }
  return {}
}

export function createApp(config) {
  const sporttery = createSportteryHandlers(config)
  const upstream = createUpstreamHandlers(config)
  const ai = createAiHandlers(config)
  const health = createHealthHandlers(config)
  const matchDetail = createMatchDetailHandler(config)
  const analysis = createAnalysisHandler(config)

  const routes = new Map([
    ['/api/matches', { methods: ['GET'], handler: sporttery.matches }],
    ['/api/history', { methods: ['GET'], handler: sporttery.history }],
    ['/api/match-detail', { methods: ['GET'], handler: matchDetail }],
    // 单场 AI 分析：只收 matchId + pool，提示词在服务端装配
    ['/api/ai-analysis', { methods: ['POST'], handler: analysis }],
    ['/api/horoscope', { methods: ['GET'], handler: upstream.horoscope }],
    ['/api/weather', { methods: ['GET'], handler: upstream.weather }],
    ['/api/ip', { methods: ['GET'], handler: upstream.ip }],
    ['/api/venue-weather', { methods: ['GET'], handler: upstream.venueWeather }],
    ['/api/ai-chat', { methods: ['POST'], handler: ai.aiChat }],
    ['/api/health', { methods: ['GET'], handler: health.health }],
  ])

  return async function app(req, res) {
    const startedAt = Date.now()
    const requestId = randomUUID()
    const method = req.method ?? 'GET'

    let url
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    } catch {
      sendError(res, 400, '非法的请求地址')
      return
    }

    const pathname = url.pathname
    const corsHeaders = buildCorsHeaders(req, config)

    for (const [key, value] of Object.entries(corsHeaders)) {
      res.setHeader(key, value)
    }
    res.setHeader('x-request-id', requestId)

    res.on('finish', () => {
      logRequest({ method, pathname, status: res.statusCode, startedAt, requestId })
    })

    // 预检
    if (method === 'OPTIONS') {
      res.writeHead(204, corsHeaders)
      res.end()
      return
    }

    // liveness：不碰数据库
    if (pathname === '/healthz') {
      sendJson(res, 200, { ok: true, uptimeSeconds: Math.round(process.uptime()) })
      return
    }

    const route = routes.get(pathname)
    if (!route) {
      sendError(res, 404, '接口不存在')
      return
    }

    const methodAllowed =
      route.methods.includes(method) || (method === 'HEAD' && route.methods.includes('GET'))
    if (!methodAllowed) {
      res.setHeader('allow', route.methods.join(', '))
      sendError(res, 405, `不支持的方法，仅允许 ${route.methods.join(', ')}`)
      return
    }

    const ctx = { req, res, url, requestId, corsHeaders: () => corsHeaders }

    try {
      await route.handler(ctx)
    } catch (error) {
      if (res.headersSent) {
        // SSE 已经开始推送，无法再改成 JSON 错误
        res.destroy()
        return
      }

      if (error instanceof HttpError) {
        sendError(res, error.status, error.message)
        return
      }

      console.error(`[api] ${pathname} 未处理异常：`, error)
      sendError(res, 500, '服务内部错误')
    }
  }
}
