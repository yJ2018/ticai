/**
 * Edge Function 通用工具（不依赖任何 Node 内置模块）。
 *
 * 为什么体彩接口要用 Edge 而不是 Node Runtime：
 * 体彩 WAF 对云厂商出口 IP 返回 HTTP 567（Vercel Node 函数 iad1 / hkg1 均被拦），
 * 且对浏览器直连返回不带 CORS 头的挑战页。Edge 运行时走的是另一套边缘出口，
 * 实测可以正常取到 JSON。
 */

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export async function proxyUpstream(target, maxAgeSeconds = 0) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 9000)

  try {
    const upstream = await fetch(target, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'user-agent': 'ticai-edge/1.0',
      },
      signal: controller.signal,
    })
    const text = await upstream.text()

    if (!upstream.ok) {
      return json({ success: false, errorMessage: `上游接口返回 HTTP ${upstream.status}` }, 502)
    }

    return new Response(text, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': maxAgeSeconds > 0 ? `public, max-age=${maxAgeSeconds}` : 'no-store',
      },
    })
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return json(
      { success: false, errorMessage: aborted ? '上游接口请求超时' : '上游接口连接失败' },
      aborted ? 504 : 502,
    )
  } finally {
    clearTimeout(timer)
  }
}
