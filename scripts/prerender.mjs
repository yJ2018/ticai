import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/**
 * 构建后预渲染公开页面。
 *
 * 纯 SPA 的 HTML 里没有正文，Google 需要排队执行 JS 才看得到内容；
 * 这里用 Playwright 打开构建产物，等接口数据渲染完，把整页 HTML 落盘：
 *   - `/`            → dist/prerender/home.html（由 vercel.json 的 rewrite 提供）
 *   - 其它公开路由   → dist/prerender/<name>.html（同上）
 *   - dist/index.html 保持 SPA 壳，供登录后 / 动态路由回落，不预渲染
 *
 * 依赖：
 *   - 本地 API（127.0.0.1:3001）可访问；不可访问时用 SPA 壳兜底，保证 rewrite 目标不 404；
 *   - 本机装有 Playwright 浏览器；没有时同样兜底。
 *
 * 页面里的 /api 请求会被拦到本地 API，因此即使构建产物里的 VITE_API_BASE 指向生产域名
 * （本机 DNS 被污染）也能拿到数据。
 */

const ROOT = process.cwd()
const API_ORIGIN = 'http://127.0.0.1:3001'
const PORT = 4174
const PUBLIC_ROUTES = [
  // 首页就是 dist/index.html：Vercel 的静态文件优先于 rewrite，`/` 只会读 index.html，
  // 所以把预渲染结果直接写回 index.html；同时把构建出的干净壳另存为 spa.html，
  // 供 /login、/my-bets、/match/:id 这类动态路由回落，避免深链先闪首页内容。
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

async function launchBrowser() {  let chromium
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

/**
 * 预渲染跑不起来时，把 SPA 壳复制到每个目标路径：
 * vercel.json 的 rewrite 指向这些文件，缺文件会 404，所以必须有兜底。
 */
async function writeShellFallback(reason, shell, spaShellPath) {
  for (const route of PUBLIC_ROUTES) {
    const target = resolve(ROOT, 'dist', route.out)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, shell, 'utf8')
  }
  await writeFile(spaShellPath, shell, 'utf8')
  console.log(`[prerender] ${reason}，已用 SPA 壳兜底（${PUBLIC_ROUTES.length} 个文件 + spa.html）`)
}

async function main() {
  const shellPath = resolve(ROOT, 'dist/index.html')
  const spaShellPath = resolve(ROOT, 'dist/spa.html')
  const shell = await readFile(shellPath, 'utf8')
  // 先把干净壳另存一份：首页预渲染会覆盖 index.html，动态路由回落到 spa.html
  await writeFile(spaShellPath, shell, 'utf8')

  if (!(await apiAlive())) {
    await writeShellFallback('本地 API 未启动', shell, spaShellPath)
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
    await writeShellFallback('preview 服务启动失败', shell, spaShellPath)
    stopPreview()
    return
  }

  const browser = await launchBrowser()
  if (!browser) {
    await writeShellFallback('没有可用的浏览器', shell, spaShellPath)
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
    await writeShellFallback('所有页面预渲染失败', shell, spaShellPath)
  }
}

await main()
