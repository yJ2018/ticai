import { createApiConfig, createHandlers } from '../server/handlers.mjs'
import { HttpError, sendError } from '../server/lib.mjs'

/**
 * Vercel Serverless Function 适配层。
 *
 * `server/handlers.mjs` 里的处理函数本身就是 `(req, res, url)` 签名，
 * 与 Node 的 http 处理器一致，因此这里只需要：
 *   1. 复用同一份 handler 实现（本地 BFF 与线上函数不会分叉）
 *   2. 补上 URL 解析与方法校验
 *   3. 统一错误出口
 */

let cachedHandlers = null

function getHandlers() {
  if (!cachedHandlers) {
    cachedHandlers = createHandlers(createApiConfig())
  }
  return cachedHandlers
}

export function createRouteHandler(routeName, { methods = ['GET'] } = {}) {
  const allow = methods.join(', ')

  return async function routeHandler(req, res) {
    const method = req.method ?? 'GET'
    const methodAllowed = methods.includes(method) || (method === 'HEAD' && methods.includes('GET'))
    if (!methodAllowed) {
      res.setHeader?.('allow', allow)
      sendError(res, 405, `不支持的方法，仅允许 ${allow}`)
      return
    }

    const host = req.headers?.host ?? 'localhost'
    let url
    try {
      url = new URL(req.url ?? '/', `http://${host}`)
    } catch {
      sendError(res, 400, '非法的请求地址')
      return
    }

    try {
      await getHandlers()[routeName](req, res, url)
    } catch (error) {
      if (res.headersSent) {
        res.destroy?.()
        return
      }
      if (error instanceof HttpError) {
        sendError(res, error.status, error.message)
        return
      }
      console.error(`[api] ${routeName} 未处理异常`, error)
      sendError(res, 500, '服务内部错误')
    }
  }
}
