import { createHash } from 'node:crypto'

/**
 * 体彩 HTTP 客户端。
 *
 * 实测结论（2026-10-22）：不带 Referer 会被 WAF 返回 **HTTP 567**，
 * 补齐 referer/origin/浏览器 UA 之后 200。所以这套头不是可选项。
 *
 * 单测/本地调试可以用 fixture 替掉 fetchImpl，不必真的联网。
 */

export const DEFAULT_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9',
  referer: 'https://www.sporttery.cn/',
  origin: 'https://www.sporttery.cn',
}

export class UpstreamError extends Error {
  constructor(message, { status = 0, retryable = false, body = '' } = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
    this.retryable = retryable
    this.body = body
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function once(url, { timeoutMs, headers, fetchImpl }) {
  let response
  try {
    response = await fetchImpl(url, {
      headers: { ...DEFAULT_HEADERS, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    })
  } catch (error) {
    throw new UpstreamError(`请求失败：${error instanceof Error ? error.message : String(error)}`, {
      retryable: true,
    })
  }

  const text = await response.text()

  if (response.status === 567) {
    throw new UpstreamError(
      '被体彩 WAF 拦截（HTTP 567）。检查 referer/user-agent；如果一直 567，说明该出口 IP 被判定异常',
      { status: 567, retryable: false, body: text.slice(0, 200) },
    )
  }

  if (!response.ok) {
    throw new UpstreamError(`上游返回 HTTP ${response.status}`, {
      status: response.status,
      retryable: response.status >= 500 || response.status === 429,
      body: text.slice(0, 200),
    })
  }

  if (!text) {
    throw new UpstreamError('上游返回空响应', { retryable: true })
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new UpstreamError('上游返回了非 JSON 内容', { body: text.slice(0, 200) })
  }
}

/** 带重试与退避的 GET JSON。567 不重试——重试只会让封禁更久。 */
export async function fetchJson(url, { timeoutMs = 15_000, retries = 2, headers = {}, fetchImpl = fetch } = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await once(url, { timeoutMs, headers, fetchImpl })
    } catch (error) {
      lastError = error
      if (!(error instanceof UpstreamError) || !error.retryable || attempt === retries) {
        throw error
      }
      await sleep(800 * (attempt + 1))
    }
  }
  throw lastError
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}
