import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { readJsonBody } from './lib.mjs'

/**
 * 分析接口反向代理：把「分析类」请求转给 Python 分析服务（apps/analysis）。
 *
 * 为什么走 Node 代理而不是让浏览器直连：
 *   - 浏览器仍然只访问同源 `/api`，不需要第二套 CORS / 域名 / 鉴权；
 *   - 前端代码零改动，切换分析实现只是服务端配置项 `ANALYSIS_API_BASE`；
 *   - 分析服务不可达时自动回退到 Node 内联实现，迁移期不会把功能打死。
 */

const ANALYSIS_PATHS = new Set([
  '/api/recommendations',
  '/api/venue-weather',
  '/api/ai-analysis',
  '/api/ai-parlay',
])
const LOTTERY_ANALYSIS_PATH = '/api/analysis/lottery'

/**
 * 哪些分析请求走 Python。
 *
 * 目前 `/api/recommendations`、`/api/analysis/lottery`（prediction / math_trend / dlt）、
 * `/api/venue-weather`（DeepSeek 城市解析 + Open-Meteo）都已由 Python 计算；
 * 任一路径不可达时 Node 自动回退内联实现。
 */
export function isAnalysisPath(pathname) {
  return ANALYSIS_PATHS.has(pathname) || pathname === LOTTERY_ANALYSIS_PATH
}

/** 读原始请求体：兼容 Node 流和平台（Vercel）预解析的 req.body。 */
async function readRawBody(req) {
  const preParsed = req.body
  if (preParsed !== undefined && preParsed !== null) {
    if (Buffer.isBuffer(preParsed)) {
      return preParsed
    }
    if (typeof preParsed === 'string') {
      return preParsed
    }
    if (typeof preParsed === 'object') {
      return JSON.stringify(preParsed)
    }
  }
  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/**
 * @returns {Promise<boolean>} true = 已经转发并写完响应；false = 调用方应回退内联实现
 */
export async function proxyAnalysis(ctx, config) {
  const base = config.analysis.baseUrl
  if (!base) {
    return false
  }

  const target = `${base}${ctx.url.pathname}${ctx.url.search}`
  const headers = { accept: 'application/json' }
  const contentType = ctx.req.headers['content-type']
  if (typeof contentType === 'string' && contentType) {
    headers['content-type'] = contentType
  }

  let body
  if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') {
    body = await readRawBody(ctx.req)
  }

  let response
  try {
    response = await fetch(target, {
      method: ctx.req.method,
      headers,
      body,
      signal: AbortSignal.timeout(config.analysis.timeoutMs),
    })
  } catch (error) {
    console.warn(`[api] 分析服务不可达（${base}），回退 Node 内联实现：${error?.message ?? error}`)
    return false
  }

  // 不能叫 x-analysis-source：开奖接口用它表示快照来源（crawler/api/computed-on-read）
  const extraHeaders = { 'x-analysis-via': 'python' }
  // 分析接口的一大半契约在响应头里（快照溯源、缓存策略、耗时），必须原样透传；
  // content-length 不能复制——这里是流式转发，长度由 Node 自己决定。
  for (const [key, value] of response.headers.entries()) {
    const name = key.toLowerCase()
    if (
      name === 'content-type' ||
      name === 'cache-control' ||
      name === 'etag' ||
      name === 'server-timing' ||
      name.startsWith('x-analysis-')
    ) {
      extraHeaders[name] = value
    }
  }

  ctx.res.writeHead(response.status, extraHeaders)

  if (!response.body) {
    ctx.res.end()
    return true
  }

  // SSE / 普通 JSON 都能直接流式透传
  try {
    await pipeline(Readable.fromWeb(response.body), ctx.res)
  } catch {
    ctx.res.destroy()
  }
  return true
}
