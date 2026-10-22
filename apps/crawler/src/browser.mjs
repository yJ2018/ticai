import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Playwright 封装。
 *
 * 中文数据站的阵容基本都是 JS 异步加载的，纯 fetch 拿不到，
 * 所以这块用真实浏览器跑。Playwright 不是必装依赖：
 * 只有用到 lineups-browser 时才加载，没装会给一条明确的安装命令。
 */

let playwright = null

export async function loadPlaywright() {
  if (playwright) {
    return playwright
  }
  try {
    playwright = await import('playwright')
    return playwright
  } catch {
    throw new Error(
      '缺少 playwright。请先在本机执行：\n' +
        '  npm i -D playwright\n' +
        '  npx playwright install chromium',
    )
  }
}

export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export async function withPage(handler, { mobile = false, headless = false } = {}) {
  const { chromium } = await loadPlaywright()

  // 优先复用系统 Chrome（省掉 150MB Chromium 下载）；没有就退回 Playwright 自带内核
  let browser
  try {
    browser = await chromium.launch({ headless, channel: 'chrome' })
  } catch {
    browser = await chromium.launch({ headless })
  }
  const context = await browser.newContext({
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: mobile ? MOBILE_UA : DESKTOP_UA,
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  })
  const page = await context.newPage()
  try {
    return await handler(page)
  } finally {
    await browser.close().catch(() => {})
  }
}

/** 从任意 JSON 里找出「像球员列表」的数组，用于第一次探测时快速定位数据结构。 */
export function findPlayerLikeArrays(payload, path = '$', out = [], depth = 0) {
  if (depth > 12 || out.length > 40) {
    return out
  }
  if (Array.isArray(payload)) {
    if (payload.length >= 5 && payload.every((item) => item && typeof item === 'object')) {
      const sample = payload[0]
      const keys = Object.keys(sample)
      const hasName = keys.some((key) => /name|player|cn|中文|球员/i.test(key))
      const hasNumber = keys.some((key) => /number|shirt|no$|num|球衣|号/i.test(key))
      if (hasName) {
        out.push({ path, length: payload.length, keys, hasNumber, sample })
      }
    }
    payload.forEach((item, index) => findPlayerLikeArrays(item, `${path}[${index}]`, out, depth + 1))
    return out
  }
  if (payload && typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload)) {
      findPlayerLikeArrays(value, `${path}.${key}`, out, depth + 1)
    }
  }
  return out
}

export async function saveDump(outDir, name, data) {
  const dir = resolve(outDir)
  await mkdir(dir, { recursive: true })
  const file = resolve(dir, name)
  await writeFile(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8')
  return file
}
