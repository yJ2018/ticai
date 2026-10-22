/**
 * 通用工具层：不依赖任何第三方包，也不依赖 HTTP 框架。
 *
 * 与旧 BFF（server/lib.mjs）的差别：只保留接口需要的能力，
 * 静态文件服务留在 web 侧，这里不掺进来。
 */

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
  if (res.writableEnded || res.destroyed) {
    return
  }
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

export function sendError(res, status, message, extraHeaders = {}) {
  sendJson(res, status, { success: false, errorMessage: message }, extraHeaders)
}

function parseJsonText(text) {
  if (!text) {
    throw new HttpError(400, '请求体不能为空')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, '请求体必须是合法 JSON')
  }
}

/**
 * 读 JSON 请求体，同时兼容两种运行环境：
 * - Node 原生 req 是可读流；
 * - 平台（Vercel）可能已预解析到 req.body。
 */
export async function readJsonBody(req, { maxBytes = 256 * 1024 } = {}) {
  const preParsed = req.body
  if (preParsed !== undefined && preParsed !== null) {
    if (Buffer.isBuffer(preParsed)) {
      return parseJsonText(preParsed.toString('utf8'))
    }
    if (typeof preParsed === 'string') {
      return parseJsonText(preParsed)
    }
    if (typeof preParsed === 'object') {
      return preParsed
    }
  }

  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) {
      throw new HttpError(413, `请求体过大（上限 ${Math.floor(maxBytes / 1024)} KB）`)
    }
    chunks.push(buffer)
  }

  return parseJsonText(Buffer.concat(chunks).toString('utf8'))
}

/** TTL + LRU，单进程用；多实例时每个实例各自计数，只用于降低上游压力。 */
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

/** IP 维度滑动窗口限流。注意：key 必须来自可信来源，否则可伪造。 */
export function createRateLimiter({ limit, windowMs = 60_000, maxKeys = 5_000 }) {
  const hits = new Map()

  return function hit(key) {
    if (!limit) {
      return
    }

    const now = Date.now()
    const recent = (hits.get(key) ?? []).filter((stamp) => now - stamp < windowMs)
    if (recent.length >= limit) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000))
      throw new HttpError(429, `调用过于频繁，请 ${retryAfter} 秒后重试`)
    }

    recent.push(now)
    hits.set(key, recent)

    if (hits.size > maxKeys) {
      for (const [storedKey, stamps] of hits) {
        if (!stamps.some((stamp) => now - stamp < windowMs)) {
          hits.delete(storedKey)
        }
      }
      if (hits.size > maxKeys) {
        hits.delete(hits.keys().next().value)
      }
    }
  }
}

function isPrivateIp(ip) {
  if (!ip) {
    return true
  }
  if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.')) {
    return true
  }
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) {
    return true
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
    return true
  }
  return ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')
}

/**
 * 取真实客户端 IP。
 *
 * ⚠️ 只有当本服务前面有可信反代（Vercel / Caddy）时才应读取 x-forwarded-for；
 * 直接暴露在公网时必须把 TRUST_PROXY 设为 0，否则谁都能伪造。
 */
export function clientIpFor(req, { trustProxy = true } = {}) {
  const forwarded = req.headers['x-forwarded-for']
  const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : (forwarded ?? '')
  const rawIp =
    (trustProxy ? firstForwarded.split(',')[0].trim() : '') || req.socket?.remoteAddress || ''
  return rawIp.replace(/^::ffff:/, '')
}

export { isPrivateIp }

/** 带超时的上游 JSON 请求，失败统一抛 HttpError。 */
export async function fetchUpstreamJson(url, { timeoutMs = 8_000, headers = {} } = {}) {
  let response
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json,text/plain,*/*',
        'user-agent': 'ticai-api/1.0',
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

export function logRequest({ method, pathname, status, startedAt, requestId }) {
  const stamp = new Date().toISOString().slice(11, 19)
  console.log(
    `${stamp} ${method.padEnd(4)} ${pathname} ${status} ${Date.now() - startedAt}ms rid=${requestId}`,
  )
}

/** 取字符串 query 参数：去控制字符、按字符截断，避免把任意内容透传给上游。 */
export function textParam(url, name, fallback = '') {
  const raw = url.searchParams.get(name)
  if (raw === null) {
    return fallback
  }
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64)
}

/** 取整数 query 参数：非法直接 400，越界夹紧而不是报错。 */
export function intParam(url, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new HttpError(400, `参数 ${name} 必须是数字`)
  }
  return Math.min(Math.max(Math.floor(value), min), max)
}
