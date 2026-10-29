import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 根据当前仓库文件清单生成 docs/architecture.svg，并尽力用本机 Edge/Chrome
 * 渲染一份 docs/architecture.png。提交前的 pre-commit hook 会自动执行。
 *
 * 说明：这里生成的是「代码结构 / 分层 / 数据流」架构图；架构说明文档里的
 * Mermaid 时序图和文字说明仍需要在功能变更时同步补写。
 */

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const docsDir = resolve(root, 'docs')
const svgPath = resolve(docsDir, 'architecture.svg')
const pngPath = resolve(docsDir, 'architecture.png')
const WIDTH = 1280
const MARGIN = 40
const INNER_WIDTH = WIDTH - MARGIN * 2
const COLUMNS = 5
const COL_GAP = 12
const CARD_HEIGHT = 60
const ROW_GAP = 10
const SECTION_HEADER = 42
const SECTION_GAP = 20
const CARD_WIDTH = (INNER_WIDTH - COL_GAP * (COLUMNS - 1)) / COLUMNS

const BETTING_DESCRIPTIONS = {
  'MatchPoolList.tsx': '赔率卡片 · AI 分析入口',
  'MatchListSkeleton.tsx': '首屏一屏骨架屏',
  'BetSlipFooter.tsx': '过关 / 倍数 / 金额栏',
  'PlanModal.tsx': '方案列表 · 快照元信息',
  'SnapshotOverlay.tsx': '快照预览 / 下载',
  'useBetSlip.ts': '选择态 · 串关注数 / 金额',
  'betSlipMath.ts': '注数 / 奖金 / 税纯函数',
  'betPayload.ts': '投注单请求体 · 登录后保存',
  'useMatchAiAnalysis.ts': '单场 AI SSE 状态机',
  'AiAnalysisPanel.tsx': '单场 AI 分析浮层',
  'aiAnalysis.ts': '单场提示词 / 摘要解析',
  'useParlayAiAnalysis.ts': '串关 AI SSE 状态机',
  'ParlayAiAnalysisPanel.tsx': '逐场判断 / 串关风险面板',
  'parlayAiAnalysis.ts': '串关提示词 / 摘要解析',
  'parlayModel.ts': '去水 → λ → 泊松 → EV 三选',
  'useAutoParlay.ts': '一键串关流水线状态机',
  'AutoParlayPanel.tsx': '串关过程可视化',
  'useAiPanelPosition.ts': '浮层定位 / 移动端抽屉',
  'AnalysisText.tsx': 'AI 文本轻量渲染',
  'aiAnalysisCache.ts': 'AI 结果缓存 · 3 小时 TTL',
}

const PAGE_DESCRIPTIONS = {
  'HomePage.tsx': '赛事投注 · 骨架屏 · 方案快照',
  'HistoryPage.tsx': '开奖历史 · 首屏骨架 · 服务端快照',
  'HistoryAnalysisPage.tsx': '频次 · 遗漏 · 马尔可夫 · 回测',
  'MathTrendAnalysisPage.tsx': '回归 · 波动率 · 大样本回测',
  'ResultsPage.tsx': '赛果开奖 · 按比赛日翻页',
  'HoroscopePage.tsx': '12 星座 × 5 周期 + 天气',
  'AuthPage.tsx': '邮箱密码 / 验证码 · 微信登录',
  'WechatCallbackPage.tsx': '一次性 ticket 换会话',
  'AccountPage.tsx': '账号资料 · 登录方式 · 微信绑定',
  'MyBetsPage.tsx': '投注记录 · 自动结算 · 详情弹层',
  'MatchDetailPage.tsx': 'H5 对战详情独立页',
  'AboutPage.tsx': 'Keep-Alive 示例页',
  'ProfilePage.tsx': '非缓存示例页',
}

const shellCards = [
  { title: 'src/app/layout.tsx', subtitle: '根布局 · 全局样式 · metadata · 挂 AppShell' },
  { title: 'src/app/[[...slug]]', subtitle: '唯一路由入口 · 404 · generateMetadata' },
  { title: 'AppShell', subtitle: '客户端外壳 · 未登记路径返回 null' },
  { title: 'App.tsx', subtitle: '顶栏 · 导航 · 路由级 SEO / 免责弹层' },
  { title: 'KeepAliveRoutes', subtitle: 'pathname 匹配 · display 切换' },
  { title: 'router/manifest.ts', subtitle: '路由清单（13 条）· 匹配 · 公开/私有' },
  { title: 'lib/navigation + nav-state', subtitle: 'useNavigate / usePathname · 一次性传参' },
  { title: 'proxy.ts + server/prefetch', subtitle: 'x-pathname → 首屏预取 → context 下发' },
  { title: 'next.config.ts', subtitle: '/api rewrite → API 项目 · allowedDevOrigins' },
]

const stateCards = [
  { title: 'Zustand store', subtitle: 'matchStore 玩法池 / authStore 登录态' },
  { title: 'src/service', subtitle: '赛事 · 开奖 · 天气 · 星座服务层' },
  { title: 'src/components', subtitle: '通用骨架屏 · 指标 / 推荐 · 确认弹窗' },
  { title: 'src/api', subtitle: 'httpClient + 同源 /api · SSE 解析' },
  { title: 'domain / analysisTypes', subtitle: '分析类型与指标展示 · 前端无预测算法' },
  { title: 'storage', subtitle: 'IndexedDB 增量缓存 · 2 万条裁剪' },
]

const featureCards = [
  { title: 'features/bets', subtitle: '投注详情弹层 · 金额 / 玩法格式化' },
  { title: 'features/account', subtitle: '微信接入步骤弹层' },
  { title: 'features/matchDetail', subtitle: '正文 / 弹框 / 视图映射 / 移动端判断' },
  { title: 'features/seo', subtitle: '路由级 title / canonical / robots' },
  { title: 'features/disclaimer', subtitle: '娱乐提示弹层 · 按路由记忆' },
]

const bffCards = [
  { title: 'apps/api/src/index.mjs', subtitle: '本地 / VPS 入口 · node:http' },
  { title: 'apps/api/src/app.mjs', subtitle: '28 个路由 · CORS · 错误信封' },
  { title: 'apps/api/src/proxy.mjs', subtitle: '分析接口 → Python · 失败回退内联' },
  { title: 'apps/api/src/handlers', subtitle: '赛事 / 赛果 / 详情 / AI / 串关' },
  { title: 'apps/api/src/handlers', subtitle: '认证 / 微信 / 投注 / 代理 / 健康检查' },
  { title: 'apps/api/src/repos', subtitle: 'matches · lottery · results · bets' },
  { title: 'apps/api/src/recommend', subtitle: '推荐引擎 Node 版 · 对拍基准 + 回退' },
  { title: 'apps/api/src/ai', subtitle: 'Node 回退：提示词 / 上下文装配' },
  { title: 'apps/crawler/src/daemon.mjs', subtitle: '串行队列 · 销售时段闸门 · 开盘补跑 · 每日 09:00' },
  { title: 'apps/crawler/src/tasks', subtitle: 'matches · results · history · details · lineups · expire · official' },
  { title: 'db/migrations', subtitle: '24 张表 + 3 个视图 · 0001 → 0008' },
]

const analysisCards = [
  { title: 'apps/analysis/api/index.py', subtitle: 'Vercel 入口 · 暴露 ASGI app' },
  { title: 'app/main.py', subtitle: 'FastAPI · 路径还原 · /healthz' },
  { title: 'app/routes', subtitle: 'recommend / lottery / weather / ai' },
  { title: 'app/recommend', subtitle: '去水 · 泊松/DC · 有界修正 · 风控 · 回测' },
  { title: 'app/analysis', subtitle: 'prediction · dlt · compute（读写快照）' },
  { title: 'app/ai', subtitle: '单场 / 串关提示词 · 上下文装配' },
  { title: 'app/llm.py / venue.py', subtitle: 'DeepSeek（流式）· Open-Meteo 天气' },
  { title: 'tests/ 38 用例', subtitle: '数学 · 风控 · 对拍 · 提示词 · 路径还原' },
]

const externalCards = [
  { title: 'webapi.sporttery.cn', subtitle: '仅本地爬虫访问 · 云 IP 被 WAF 拦截' },
  { title: '500.com', subtitle: '阵容（有头 Playwright）· 按场次号匹配' },
  { title: '聚合数据 juhe.cn', subtitle: '天气 · 星座 · IP 归属地' },
  { title: 'DeepSeek API', subtitle: 'chat/completions · SSE' },
  { title: 'Open-Meteo', subtitle: 'Geocoding + Forecast' },
  { title: 'Resend / 微信开放平台', subtitle: '邮箱验证码 · 扫码 / 网页授权' },
  { title: 'Vercel', subtitle: 'ticai 前端 · API · Python 分析' },
]

const sections = [
  {
    title: '① 应用外壳与路由',
    color: '#3b82f6',
    caption: '入口 → 布局 → 自研 Keep-Alive 路由',
    cards: shellCards,
  },
  {
    title: '② 页面层 src/views',
    color: '#10b981',
    caption: '页面自管理状态与请求 · 由 AppShell 按 pathname 分发',
    cards: readSourceCards('src/views', PAGE_DESCRIPTIONS, '页面模块'),
  },
  {
    title: '③ 赛事投注 features/betting',
    color: '#f59e0b',
    caption: '选择 → 串关 → AI 分析 → 方案快照，全部在浏览器端编排',
    cards: readSourceCards(
      'src/features/betting',
      BETTING_DESCRIPTIONS,
      '投注模块',
      (file) => basename(file),
    ),
  },
  {
    title: '④ 账号、投注与详情 features',
    color: '#ec4899',
    caption: '登录 / 投注记录 / 对战详情 / SEO / 免责各成模块',
    cards: featureCards,
  },
  {
    title: '⑤ 状态、服务与数据',
    color: '#8b5cf6',
    caption: 'Zustand / service / api / domain / IndexedDB 分层',
    cards: stateCards,
  },
  {
    title: '⑥ Python 分析服务 apps/analysis',
    color: '#14b8a6',
    caption: '推荐 / 开奖 / 走势 / 大乐透 / 天气 / AI · 唯一算法实现',
    cards: analysisCards,
  },
  {
    title: '⑦ 服务端 apps/api + apps/crawler + 数据库',
    color: '#0ea5e9',
    caption: 'Node API 读库并代理分析 · 爬虫写库 · 密钥与提示词不出服务端',
    cards: bffCards,
  },
  {
    title: '⑧ 外部数据源与部署',
    color: '#ef4444',
    caption: '前端只连自有 API；爬虫在本机抓上游；push 前更新架构图',
    cards: externalCards,
  },
]

function readSourceCards(relativeDir, descriptions, fallback, nameOf = (file) => file) {
  const dir = resolve(root, relativeDir)
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ['.ts', '.tsx'].includes(extname(entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      title: nameOf(entry.name),
      subtitle: descriptions[entry.name] || fallback,
    }))
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function truncate(value, maxChars) {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function walkFiles(dir) {
  if (!existsSync(dir)) {
    return []
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name)
    return entry.isDirectory() ? walkFiles(fullPath) : [fullPath]
  })
}

function countLines(files) {
  return files.reduce((sum, file) => {
    const content = readFileSync(file, 'utf8')
    return sum + (content ? content.split(/\r?\n/).length : 0)
  }, 0)
}

function collectStats() {
  const srcFiles = walkFiles(resolve(root, 'src'))
  const sourceFiles = srcFiles.filter((file) => ['.ts', '.tsx'].includes(extname(file)))
  const scssFiles = srcFiles.filter((file) => extname(file) === '.scss')
  const serverFiles = [
    ...walkFiles(resolve(root, 'apps/api')),
    ...walkFiles(resolve(root, 'apps/analysis')),
    ...walkFiles(resolve(root, 'apps/crawler')),
  ].filter(
    (file) =>
      ['.mjs', '.js', '.py'].includes(extname(file)) &&
      !file.includes('node_modules') &&
      !file.includes('.venv') &&
      !file.includes('__pycache__') &&
      !/[\\/]tests?[\\/]/.test(file),
  )

  return {
    sourceCount: sourceFiles.length,
    sourceLines: countLines(sourceFiles),
    scssCount: scssFiles.length,
    scssLines: countLines(scssFiles),
    serverCount: serverFiles.length,
    serverLines: countLines(serverFiles),
  }
}

function renderCard(card, x, y, color) {
  const title = truncate(card.title, 27)
  const subtitle = truncate(card.subtitle, 38)

  return [
    `<g>`,
    `<title>${escapeXml(`${card.title} — ${card.subtitle}`)}</title>`,
    `<rect x="${x}" y="${y}" width="${CARD_WIDTH.toFixed(1)}" height="${CARD_HEIGHT}" rx="8" fill="#ffffff" stroke="#e2e8f0"/>`,
    `<rect x="${x}" y="${y}" width="3" height="${CARD_HEIGHT}" rx="1.5" fill="${color}" opacity="0.8"/>`,
    `<text x="${(x + 12).toFixed(1)}" y="${y + 23}" font-size="12.5" font-weight="600" fill="#0f172a">${escapeXml(title)}</text>`,
    `<text x="${(x + 12).toFixed(1)}" y="${y + 42}" font-size="10.5" fill="#64748b">${escapeXml(subtitle)}</text>`,
    `</g>`,
  ].join('')
}

function renderSection(section, y) {
  const rows = Math.ceil(section.cards.length / COLUMNS)
  const height = SECTION_HEADER + rows * CARD_HEIGHT + (rows - 1) * ROW_GAP + 12
  const parts = [
    `<g>`,
    `<rect x="${MARGIN}" y="${y}" width="${INNER_WIDTH}" height="${height}" rx="14" fill="#ffffff" stroke="#e2e8f0"/>`,
    `<rect x="${MARGIN + 12}" y="${y + 13}" width="4" height="18" rx="2" fill="${section.color}"/>`,
    `<text x="${MARGIN + 26}" y="${y + 27}" font-size="14" font-weight="700" fill="${section.color}">${escapeXml(section.title)}</text>`,
    `<text x="${WIDTH - MARGIN - 22}" y="${y + 27}" text-anchor="end" font-size="10.5" fill="#94a3b8">${escapeXml(section.caption)}</text>`,
  ]

  section.cards.forEach((card, index) => {
    const row = Math.floor(index / COLUMNS)
    const column = index % COLUMNS
    const x = MARGIN + 22 + column * (CARD_WIDTH + COL_GAP)
    const cardY = y + SECTION_HEADER + row * (CARD_HEIGHT + ROW_GAP)
    parts.push(renderCard(card, x, cardY, section.color))
  })

  parts.push('</g>')
  return { svg: parts.join(''), height }
}

function findBrowser() {
  const candidates = [
    process.env.ARCH_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean)

  return candidates.find((candidate) => existsSync(candidate))
}

function renderPng(svgWidth, svgHeight) {
  const browser = findBrowser()
  if (!browser) {
    console.warn('[architecture] 未找到 Edge/Chrome，保留现有 architecture.png；SVG 已更新。')
    return false
  }

  const profileDir = mkdtempSync(join(tmpdir(), 'ticai-arch-'))
  try {
    execFileSync(
      browser,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--hide-scrollbars',
        `--user-data-dir=${profileDir}`,
        `--window-size=${svgWidth},${svgHeight}`,
        `--screenshot=${pngPath}`,
        pathToFileURL(svgPath).href,
      ],
      { stdio: 'ignore', timeout: 60_000 },
    )
    return existsSync(pngPath)
  } catch (error) {
    console.warn(
      `[architecture] PNG 渲染失败，SVG 已更新：${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
}

function buildSvg() {
  const stats = collectStats()
  const headerHeight = 110
  let currentY = headerHeight
  const blocks = []

  sections.forEach((section, index) => {
    const rendered = renderSection(section, currentY)
    blocks.push(rendered.svg)
    currentY += rendered.height

    if (index < sections.length - 1) {
      const arrowTop = currentY + 5
      const arrowBottom = currentY + SECTION_GAP - 5
      for (const x of [200, 640, 1080]) {
        blocks.push(
          `<line x1="${x}" y1="${arrowTop}" x2="${x}" y2="${arrowBottom}" stroke="#cbd5e1" stroke-width="1.6" marker-end="url(#ar)"/>`,
        )
      }
      currentY += SECTION_GAP
    }
  })

  const height = currentY + 56
  const footerY = currentY + 26
  const header = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" font-family="'Microsoft YaHei','PingFang SC','Noto Sans SC','Segoe UI',sans-serif">`,
    `<defs><marker id="ar" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 Z" fill="#94a3b8"/></marker></defs>`,
    `<rect width="${WIDTH}" height="${height}" fill="#f5f7fa"/>`,
    `<text x="40" y="56" font-size="26" font-weight="700" fill="#0f172a">体彩助手 · ticai 全栈架构图</text>`,
    `<text x="40" y="80" font-size="12.5" fill="#64748b">React 19 · Next.js 16 App Router · TypeScript 6 · Zustand 5　＋　Node API（apps/api）＋ Python 分析（apps/analysis）＋ 本地爬虫（apps/crawler）</text>`,
    `<text x="${WIDTH - 40}" y="55" text-anchor="end" font-size="11" fill="#475569">src ${formatNumber(stats.sourceCount)} 文件 / ${formatNumber(stats.sourceLines)} 行</text>`,
    `<text x="${WIDTH - 40}" y="74" text-anchor="end" font-size="11" fill="#475569">SCSS ${stats.scssCount} 文件 / ${formatNumber(stats.scssLines)} 行</text>`,
    `<text x="${WIDTH - 40}" y="93" text-anchor="end" font-size="11" fill="#475569">apps ${stats.serverCount} 文件 / ${formatNumber(stats.serverLines)} 行</text>`,
    `<text x="40" y="98" font-size="10.5" fill="#94a3b8">自动生成：scripts/update-architecture.mjs　·　方框 = 仓库内代码　·　箭头 = 依赖方向</text>`,
    `<line x1="40" y1="108" x2="${WIDTH - 40}" y2="108" stroke="#e2e8f0"/>`,
  ].join('\n')

  const footer = [
    `<text x="40" y="${footerY}" font-size="10.5" fill="#94a3b8">数据来源：按当前 src、apps/api、apps/analysis、apps/crawler 文件清单生成；新增模块会自动出现在图中。</text>`,
    `<text x="${WIDTH - 40}" y="${footerY}" text-anchor="end" font-size="10.5" fill="#94a3b8">提交前 hook 同步 SVG / PNG</text>`,
  ].join('\n')

  return `${header}\n${blocks.join('\n')}\n${footer}\n</svg>\n`
}

function main() {
  const svg = buildSvg()
  const previous = existsSync(svgPath) ? readFileSync(svgPath, 'utf8') : ''
  const changed = svg !== previous
  if (changed) {
    writeFileSync(svgPath, svg, 'utf8')
    console.log('[architecture] SVG 已更新')
  } else {
    console.log('[architecture] SVG 无变化')
  }

  if (!changed && existsSync(pngPath)) {
    return
  }

  const viewBox = readFileSync(svgPath, 'utf8').match(/viewBox="0 0 (\d+) (\d+)"/)
  const height = viewBox ? Number(viewBox[2]) : 1200
  if (renderPng(WIDTH, height)) {
    console.log('[architecture] PNG 已渲染')
  }
}

main()
