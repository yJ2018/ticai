import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/**
 * 构建后预渲染公开页面。
 *
 * 纯 SPA 的 HTML 里没有正文，Google 需要排队执行 JS 才看得到内容；
 * 这里用 Playwright 打开构建产物，等接口数据渲染完，把整页 HTML 落盘：
 *   - `/`            → dist/index.html
 *   - 其它公开路由   → dist/prerender/<name>.html（由 vercel.json 的 rewrite 指向）
 *
 * 依赖：
 *   - 本地 API（127.0.0.1:3001）可访问；不可访问就跳过，不阻断构建；
 *   - 本机装有 Playwright 浏览器；没有就跳过。
 *
 * 页面里的 /api 请求会被拦到本地 API，因此即使构建产物里的 VITE_API_BASE 指向生产域名
 * （本机 DNS 被污染）也能拿到数据。
 */

const ROOT = process.cwd()
const API_ORIGIN = 'http://127.0.0.1:3001'
const PORT = 4174
const PUBLIC_ROUTES = [
  { path: '/', out: 'index.html' },
  { path: '/results', out: 'prerender/results.html' },
  { path: '/history', out: 'prerender/history.html' },
  { path: '/history-analysis', out: 'prerender/history-analysis.html' },
  { path: '/math-trend-analysis', out: 'prerender/math-trend-analysis.html' },
  { path: '/horoscope', out: 'prerender/horoscope.html' },
  { path: '/about', out: 'prerender/about.html' },
]

const DISCLAIMER_PREFIX = 'ticai.entertainment-disclaimer.hidden.v1'
const DISCLAIMER_PATHS = ['/', '/history', '/history-analysis', '/math-trend-analysis']

async function apiAlive() {
  try {
    const response = await fetch(`${API_ORIGIN}/healthz`, { signal: AbortSignal.timeout(2500) })
    return response.ok
  } catch {
    return false
  }
}

async function waitForServer(url, timeoutMs = 20000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return true
      }
    } catch {
      // 还没起来，继续等
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 400))
  }
  return false
}

async function launchBrowser() {
  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    return null
  }

  try {
    return await chromium.launch({ headless: true, channel: 'chrome' })
  } catch {
    try {
      return await chromium.launch({ headless: true })
    } catch {
      return null
    }
  }
}

async function main() {
  if (!(await apiAlive())) {
    console.log('[prerender] 本地 API 未启动，跳过预渲染（不影响构建）')
    return
  }

  const preview = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: 'ignore' },
  )
  const stopPreview = () => {
    try {
      preview.kill()
    } catch {
      // ignore
    }
  }
  process.on('exit', stopPreview)

  if (!(await waitForServer(`http://localhost:${PORT}/`))) {
    console.log('[prerender] preview 服务启动失败，跳过预渲染')
    stopPreview()
    return
  }

  const browser = await launchBrowser()
  if (!browser) {
    console.log('[prerender] 没有可用的浏览器，跳过预渲染')
    stopPreview()
    return
  }

  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })
  // 预渲染时不要弹「仅供娱乐」，否则会被一起写进静态 HTML
  await context.addInitScript(
    ([prefix, paths]) => {
      for (const path of paths) {
        try {
          window.localStorage.setItem(`${prefix}:${path}`, '1')
        } catch {
          // ignore
        }
      }
    },
    [DISCLAIMER_PREFIX, DISCLAIMER_PATHS],
  )

  // 构建产物里的 API 域名在本机被 DNS 污染，统一拦截到本地 API
  await context.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    try {
      const response = await fetch(`${API_ORIGIN}${url.pathname}${url.search}`, {
        method: request.method(),
      })
      await route.fulfill({
        status: response.status,
        contentType: response.headers.get('content-type') ?? 'application/json; charset=utf-8',
        body: await response.text(),
      })
    } catch {
      await route.abort()
    }
  })

  let rendered = 0
  for (const route of PUBLIC_ROUTES) {
    const page = await context.newPage()
    try {
      await page.goto(`http://localhost:${PORT}${route.path}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      })
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
      await page.waitForTimeout(700)

      const html = await page.content()
      const target = resolve(ROOT, 'dist', route.out)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, html, 'utf8')

      if (html.includes('class="entertainment-disclaimer')) {
        console.warn(`[prerender] ${route.path} 的 HTML 里出现了免责声明弹层，请检查`)
      }
      console.log(`[prerender] ${route.path} → dist/${route.out}（${Math.round(Buffer.byteLength(html) / 1024)} KB）`)
      rendered += 1
    } catch (error) {
      console.warn(`[prerender] ${route.path} 失败：${error instanceof Error ? error.message : error}`)
    } finally {
      await page.close().catch(() => {})
    }
  }

  await browser.close()
  stopPreview()
  console.log(`[prerender] 完成 ${rendered}/${PUBLIC_ROUTES.length}`)
  if (rendered === 0) {
    process.exitCode = 1
  }
}

await main()
