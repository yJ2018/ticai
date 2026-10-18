import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'

/**
 * 极简 .env 读取：不覆盖已存在的 process.env（方便命令行临时覆盖）。
 * 避免引入 dotenv 依赖。
 */
export function loadEnvFile(filePath = resolve(process.cwd(), '.env')) {
  if (!existsSync(filePath)) {
    return false
  }

  let text = ''
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return false
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const separator = line.indexOf('=')
    if (separator <= 0) {
      continue
    }

    const key = line.slice(0, separator).trim()
    if (!key || key in process.env) {
      continue
    }

    let value = line.slice(separator + 1).trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }

  return true
}

export function env(name, fallback = '') {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

export function envInt(name, fallback) {
  const parsed = Number(env(name, ''))
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export function stripTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

export class HttpError extends Error {
  constructor(status, message, code = '') {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...BASE_HEADERS,
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  })
  res.end(payload)
}

export function sendData(res, data, extraHeaders = {}) {
  sendJson(res, 200, { success: true, data }, extraHeaders)
}

export function sendError(res, status, message) {
  sendJson(res, status, { success: false, errorMessage: message })
}

/**
 * 简单的 TTL + LRU 缓存：够用于"降低上游压力"，不追求精确统计。
 */
export function createTtlCache({ ttlMs = 60_000, maxEntries = 200 } = {}) {
  const store = new Map()

  return {
    get(key) {
      const hit = store.get(key)
      if (!hit) {
        return undefined
      }
      if (hit.expiresAt <= Date.now()) {
        store.delete(key)
        return undefined
      }
      // 触碰即刷新 LRU 位置
      store.delete(key)
      store.set(key, hit)
      return hit.value
    },
    set(key, value, ttl = ttlMs) {
      if (store.size >= maxEntries) {
        const oldest = store.keys().next().value
        if (oldest !== undefined) {
          store.delete(oldest)
        }
      }
      store.delete(key)
      store.set(key, { value, expiresAt: Date.now() + ttl })
    },
    get size() {
      return store.size
    },
  }
}

/**
 * 带超时的上游 JSON 请求。失败统一抛 HttpError，由上层转成一致错误响应。
 */
export async function fetchUpstreamJson(url, { timeoutMs = 8_000, headers = {} } = {}) {
  let response
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json,text/plain,*/*',
        'user-agent': 'ticai-bff/1.0',
        ...headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new HttpError(504, '上游接口请求超时')
    }
    throw new HttpError(502, `上游接口连接失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const text = await response.text()
  if (!response.ok) {
    throw new HttpError(502, `上游接口返回 HTTP ${response.status}`)
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(502, '上游接口返回了非 JSON 内容')
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

/**
 * 返回 false 表示"未命中静态文件"，交给 SPA fallback 处理。
 * 命中时已经写好响应。
 */
export function tryServeStatic(root, pathname, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false
  }

  if (pathname.includes('..') || pathname.includes('\0')) {
    return false
  }

  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return false
  }

  if (decoded.includes('\0')) {
    return false
  }

  const relative = decoded === '/' ? '/index.html' : decoded
  const target = resolve(root, `.${relative}`)
  if (target !== root && !target.startsWith(root + sep)) {
    return false
  }

  if (!existsSync(target)) {
    return false
  }

  const stats = statSync(target)
  if (!stats.isFile()) {
    return false
  }

  const extension = extname(target).toLowerCase()
  const immutable = relative.startsWith('/assets/')

  res.writeHead(200, {
    'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
    'content-length': stats.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  })

  if (req.method === 'HEAD') {
    res.end()
    return true
  }

  const stream = createReadStream(target)
  stream.on('error', () => {
    res.destroy()
  })
  stream.pipe(res)
  return true
}

export function logRequest(method, pathname, status, startedAt) {
  const duration = Date.now() - startedAt
  const stamp = new Date().toISOString().slice(11, 19)
  console.log(`${stamp} ${method.padEnd(4)} ${pathname} ${status} ${duration}ms`)
}
