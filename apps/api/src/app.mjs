import { randomUUID } from 'node:crypto'

import { HttpError, logRequest, sendError, sendJson } from './lib.mjs'
import { createAiHandlers } from './handlers/ai.mjs'
import { createAnalysisHandler } from './handlers/analysis.mjs'
import { createAuthHandlers } from './handlers/auth.mjs'
import { createBetHandlers } from './handlers/bets.mjs'
import { createHealthHandlers } from './handlers/health.mjs'
import { createLotteryAnalysisHandlers } from './handlers/lottery-analysis.mjs'
import { createMatchDetailHandler } from './handlers/match-detail.mjs'
import { createOddsDistributionHandlers } from './handlers/odds-distribution.mjs'
import { createParlayHandler } from './handlers/parlay.mjs'
import { createRecommendationHandlers } from './handlers/recommendations.mjs'
import { createResultsHandlers } from './handlers/results.mjs'
import { createSportteryHandlers } from './handlers/sporttery.mjs'
import { createUpstreamHandlers } from './handlers/upstream.mjs'
import { createWechatHandlers } from './handlers/wechat.mjs'
import { isAnalysisPath, proxyAnalysis } from './proxy.mjs'

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
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      // authorization：登录后的接口用 Bearer token
      'access-control-allow-headers': 'content-type,accept,authorization,x-session-token',
      // 跨域时自定义响应头默认不可读，前端要读数据更新时间/比赛数/分析溯源
      'access-control-expose-headers':
        'x-data-as-of,x-match-count,x-draw-count,server-timing,' +
        'x-analysis-through-issue,x-analysis-through-date,x-analysis-draw-count,' +
        'x-analysis-computed-at,x-analysis-stale,x-analysis-source,' +
        'x-analysis-game,x-analysis-kind,x-analysis-config,x-analysis-via,x-ttg-samples',
      'access-control-max-age': '86400',
      vary: 'Origin',
    }
  }
  return {}
}

/** 把 /api/bets/:id 这类模板编译成正则，顺便拿到参数名。 */
function compileRoute(path) {
  const names = []
  const pattern = path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(':')) {
        names.push(segment.slice(1))
        return '([^/]+)'
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { regex: new RegExp(`^/${pattern}/?$`), names }
}

export function createApp(config) {
  const sporttery = createSportteryHandlers(config)
  const upstream = createUpstreamHandlers(config)
  const ai = createAiHandlers(config)
  const health = createHealthHandlers(config)
  const lotteryAnalysis = createLotteryAnalysisHandlers(config)
  const matchDetail = createMatchDetailHandler(config)
  const analysis = createAnalysisHandler(config)
  const parlay = createParlayHandler(config)
  const recommendations = createRecommendationHandlers(config)
  const results = createResultsHandlers(config)
  const oddsDistribution = createOddsDistributionHandlers(config)
  const auth = createAuthHandlers(config)
  const bets = createBetHandlers(config)
  const wechat = createWechatHandlers(config)

  const routes = [
    ['/api/matches', ['GET'], sporttery.matches],
    ['/api/history', ['GET'], sporttery.history],
    // 全量开奖的紧凑格式：只给「本地调参」用，一次 45 KB（gzip）
    ['/api/history/bulk', ['GET'], sporttery.historyBulk],
    // 开奖分析快照：开奖后由爬虫算好，这里只读（缺失时兜底现算一次）
    ['/api/analysis/lottery', ['GET'], lotteryAnalysis.latest],
    ['/api/analysis/lottery/snapshots', ['GET'], lotteryAnalysis.snapshots],
    ['/api/results', ['GET'], results.results],
    // 开奖记录 × 总进球赔率：不限时间的最低 / 第二低 / 第三低 / 中奖赔率分布
    ['/api/odds-distribution', ['GET'], oddsDistribution.ttg],
    ['/api/match-detail', ['GET'], matchDetail],
    // 单场 AI 分析：只收 matchId + pool，提示词在服务端装配
    ['/api/ai-analysis', ['POST'], analysis],
    // 串关 AI 分析：只收选中的场次与选项
    ['/api/ai-parlay', ['POST'], parlay],
    // 投注推荐：服务端读库算概率与方案（赔率去水 + 伤停/近况有界修正 + 串关风控）
    ['/api/recommendations', ['GET'], recommendations.recommend],
    ['/api/horoscope', ['GET'], upstream.horoscope],
    ['/api/weather', ['GET'], upstream.weather],
    ['/api/ip', ['GET'], upstream.ip],
    ['/api/venue-weather', ['GET'], upstream.venueWeather],
    ['/api/ai-chat', ['POST'], ai.aiChat],
    ['/api/health', ['GET'], health.health],
    // 可选登录
    ['/api/auth/code', ['POST'], auth.issueCode],
    ['/api/auth/register', ['POST'], auth.register],
    ['/api/auth/login', ['POST'], auth.login],
    ['/api/auth/logout', ['POST'], auth.logout],
    ['/api/auth/me', ['GET'], auth.me],
    // 登录后设置 / 修改密码；给没有邮箱的账号（微信建的）绑定邮箱
    ['/api/auth/password', ['POST'], auth.setPassword],
    ['/api/auth/email', ['POST'], auth.bindEmail],
    // 第三方身份（当前只接微信；以后加渠道只加 adapter）
    ['/api/auth/identities', ['GET'], wechat.identities],
    ['/api/auth/identities/:provider', ['DELETE'], wechat.unbind],
    ['/api/auth/wechat/config', ['GET'], wechat.getConfig],
    ['/api/auth/wechat/start', ['GET'], wechat.start],
    ['/api/auth/wechat/callback', ['GET'], wechat.callback],
    ['/api/auth/wechat/session', ['POST'], wechat.exchange],
    // 我的投注（需要登录）。静态路由要排在 :id 之前
    ['/api/bets', ['GET', 'POST'], (ctx) => (ctx.req.method === 'POST' ? bets.create(ctx) : bets.list(ctx))],
    ['/api/bets/stats', ['GET'], bets.stats],
    ['/api/bets/:id', ['GET', 'DELETE'], (ctx) => (ctx.req.method === 'DELETE' ? bets.remove(ctx) : bets.detail(ctx))],
  ].map(([path, methods, handler]) => ({ ...compileRoute(path), methods, handler, path }))

  function matchRoute(pathname) {
    for (const route of routes) {
      const hit = route.regex.exec(pathname)
      if (!hit) {
        continue
      }
      const params = {}
      route.names.forEach((name, index) => {
        params[name] = decodeURIComponent(hit[index + 1] ?? '')
      })
      return { route, params }
    }
    return null
  }

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

    const matched = matchRoute(pathname)
    if (!matched) {
      sendError(res, 404, '接口不存在')
      return
    }

    const { route, params } = matched
    const methodAllowed =
      route.methods.includes(method) || (method === 'HEAD' && route.methods.includes('GET'))
    if (!methodAllowed) {
      res.setHeader('allow', route.methods.join(', '))
      sendError(res, 405, `不支持的方法，仅允许 ${route.methods.join(', ')}`)
      return
    }

    const ctx = { req, res, url, params, requestId, corsHeaders: () => corsHeaders }

    try {
      // 分析类接口：配置了 ANALYSIS_API_BASE 就转发给 Python 分析服务，
      // 不可达时回退到本进程的内联实现（迁移期两个实现并存，接口形状一致）
      if (isAnalysisPath(pathname) && (await proxyAnalysis(ctx, config))) {
        return
      }
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
