# SSR 改造方案（ticai）

> **⚠️ 已废弃（2026-10-28）**：本方案（自建 Vite SSR）执行到 P1 后，项目改为 **Next.js 16 App Router**。
> 当时的产出已删除，可复用的部分（`resolvePageMeta` 纯函数、`api/env.ts`、路由白名单思路）已经迁到 Next 版本。
> 当前架构见 [architecture.md](architecture.md) 第 13 节；本文仅作历史留档，不要再按它施工。

> 目标：把前端从「纯 SPA + 构建时 Playwright 预渲染」升级成「公开页按需 SSR」，
> 让爬虫和首屏直接拿到**带正文、带 meta、数据不陈旧**的 HTML，
> 同时不动现有路由模型、Keep-Alive、AI SSE、IndexedDB 这些客户端能力。
>
> 结论：**方案 A —— 在现有 Vite + React 19 上自建 Vite SSR，配一个 Vercel Node Function**，
> 只对 8 个公开路由做 SSR，登录后页面继续走 SPA。预估 **5.5 ~ 7 人日**（单人）。
> 如果目的只是「让 Google 稳定收录、不追求详情页实时」，先做第 10 节的 B 方案，**1 人日**。

**进度（历史）**：P0（可行性 spike）+ P1（双构建骨架）已完成 —— `/about` 能 SSR 出正文与 meta，
hydration 无控制台告警。后续转向 Next.js，P2 及以后未执行。

---

## 1. 现状：已经有预渲染，为什么还要 SSR

| 现状 | 问题 |
| --- | --- |
| `npm run build` 末尾跑 `scripts/prerender.mjs`，Playwright 逐页打开、落盘 7 个 HTML | 数据是**构建时刻快照**；不重新构建就永远是旧的 |
| 预渲染依赖「本地 API 在 3001 在线」+「本机有 Chrome」 | 任一缺失就走 `writeShellFallback` 静默退化成空壳，线上可能悄悄没有正文，而且**构建不报错** |
| `/match/:id` 不预渲染，走 `spa.html` 兜底 | 比赛详情是对爬虫的空壳，几千场比赛的长尾流量拿不到 |
| `applyPageMeta()` 在 `App` 的 `useEffect` 里调用 | title/description/canonical 只有执行 JS 后才有；原始 HTML 里是 `index.html` 的通用默认值 |
| `public/sitemap.xml` 固定 7 条 | 没有比赛详情页入口 |
| 构建时长随页面数线性增长 | 想给每个在售比赛生成静态页，构建会变成几分钟且极不稳定 |

也就是说：**预渲染解决的是「有没有正文」，SSR 解决的是「正文是不是当下这一份、能不能覆盖动态路由」**。

## 2. 目标与非目标

**目标**

1. 8 条公开路由 + `/match/:id` 返回带正文与完整 meta 的 HTML（`curl` 可验证，不依赖 JS）。
2. 数据新鲜度跟随 API（API 侧本身有 15~60s 缓存），不再等构建。
3. `npm run build` 不再需要浏览器和本地 API。
4. 爬虫友好：正确的 `200/404`、canonical、`noindex`、JSON-LD、比赛 sitemap。
5. 可回退、可观测、可灰度。

**非目标（明确不做）**

- 不做登录态 SSR：token 存在 `localStorage`（`src/store/authStore.ts`），服务端拿不到，做了也没有收益。
- 不改路由与交互：`KeepAliveRoutes`、投注单、AI SSE 流式分析、IndexedDB 开奖缓存全部原样留在客户端。
- 不引入新的数据层 / ORM / BFF。SSR 只是「先取一次数、先渲染一次」。
- 不做流式渲染（`renderToPipeableStream`）。第一期用 `renderToString`，够用且好排查；后续要优化 TTFB 再说。

## 3. 选型对比

| 方案 | 改动量 | 首屏/SEO | 动态页 | 主要风险 | 工期 |
| --- | --- | --- | --- | --- | --- |
| **A. Vite 自建 SSR + Vercel Function**（推荐） | 中 | 好（按需渲染 + CDN 缓存） | 支持 | hydration 不一致、部署链路变复杂 | 5.5–7 人日 |
| B. 扩展现有预渲染（SSG） | 小 | 好（构建时） | 需预生成，数据陈旧 | 构建时长与稳定性 | 1 人日 |
| C. 迁 React Router v7 framework mode | 中大 | 好 | 支持 | 与自研 `KeepAliveRoutes` 冲突，路由要重写 | 10–15 人日 |
| D. 迁 Next.js App Router | 大 | 好 | 支持 | 路由、全局 Sass、数据层、`main.tsx` 全要重写 | 20–30 人日 |
| E. Edge Middleware 注入 meta | 小 | 只有 meta，没正文 | 支持 | 内容仍靠 JS，SEO 提升有限 | 1–2 人日 |

**为什么是 A**：这个仓库最贵的是「路由 + 页面状态 + 数据层」这套已经跑通的东西，SSR 只需要在**入口层**加一双构建，页面代码基本不动；而 C/D 会把最贵的部分重写一遍，收益和 A 一样。
**为什么不上 Vike**：Vike 自带文件路由，会和 `src/router/routes.tsx` + `KeepAliveRoutes` 打架，改造成本反而高于自建。

## 4. 方案 A 的运行时结构

```
浏览器 / Googlebot
   │
   ├─ /assets/*、图标、robots.txt、sitemap.xml ──→ Vercel CDN（静态直出，immutable）
   │
   ├─ /api/* ──→ rewrite ──→ ticai-service（现有 API 项目，不动）
   │
   └─ 其它路径 ──→ /ssr?p=<原路径>（Node Function）
                       │
                       ├─ loadPageData(path)  ──fetch──→ SSR_API_ORIGIN + /api/...
                       ├─ renderToString(<StaticRouter><App/></StaticRouter>)
                       ├─ resolvePageMeta(path, data) → 注入 <head>
                       └─ HTML + Cache-Control: s-maxage / stale-while-revalidate
```

**构建产物**

```
dist/client/           # 现有静态产物（assets、图标、robots、sitemap），不含 index.html
dist/server/           # 单个 SSR bundle（React、router 全部内联，函数目录不需要 node_modules）
.vercel/output/
  ├─ static/           # ← dist/client
  ├─ functions/ssr.func/{index.mjs, .vc-config.json}   # ← dist/server + 适配器
  └─ config.json       # 路由与缓存头
```

关键点：**内联打包（`ssr.noExternal: true`）**。这样函数目录只有 1 个 JS 文件，不必依赖 Vercel 的依赖追踪，冷启动也可控。

## 5. 具体设计

### 5.1 双构建

- `vite.config.ts`（客户端）：`build.outDir: 'dist/client'`，其余不变。
- 新增 `vite.config.server.ts`：

```ts
export default defineConfig({
  plugins: [react(), ssrTemplatePlugin()],
  build: {
    ssr: 'src/entry-server.tsx',
    outDir: 'dist/server',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'entry-server.mjs' } },
  },
  ssr: { noExternal: true, target: 'node' },
})
```

- `package.json`：`"build": "tsc && node scripts/build.mjs"`，`build.mjs` 依次跑客户端构建、服务端构建、产物校验（三段都是几十行）。

### 5.2 入口

`src/main.tsx` 拆成两个入口，逻辑不重复：

```tsx
// src/entry-client.tsx
import { hydrateRoot } from 'react-dom/client'
import { setSsrPayload } from './ssr/bootstrap'

setSsrPayload((window as any).__SSR_DATA__ ?? null)   // 必须在 hydrateRoot 之前
hydrateRoot(document.getElementById('app')!, (
  <BrowserRouter><ConfirmDialogProvider><App /></ConfirmDialogProvider></BrowserRouter>
))
```

```tsx
// src/entry-server.tsx
export async function render(url: string) {
  const payload = await loadPageData(url)      // 见 5.5
  setSsrPayload(payload)
  try {
    const appHtml = renderToString(
      <StaticRouter location={url}><ConfirmDialogProvider><App /></ConfirmDialogProvider></StaticRouter>,
    )
    return { status: payload.status, html: inject(appHtml, payload), cacheControl: payload.cacheControl }
  } finally {
    setSsrPayload(null)                        // 一定清，避免跨请求串数据
  }
}
```

> `renderToString` 是同步的，模块级 `currentPayload` 在「取数 → 渲染」之间不会被打断，所以跨请求串数据只可能发生在忘记 `finally` 时——实现时用 `try/finally` 兜住。
> `react-router-dom@6.30.3` 自带 `server.mjs`，`StaticRouter` 可直接用。

### 5.3 模板：用虚拟模块把构建好的 HTML 注进 bundle

预渲染时代 `dist/index.html` 是成品；SSR 时代它要变成模板。不要用运行时 `readFileSync`（Vercel 依赖追踪会漏文件），用 Vite 插件的虚拟模块在**构建期**读：

```ts
// vite.config.server.ts 里的插件
load(id) {
  if (id !== '\0virtual:ssr-template') return null
  const html = readFileSync('dist/client/index.html', 'utf8')
  const [head, tail] = html.split('<div id="app"></div>')
  return `export const head = ${JSON.stringify(head)}
export const tail = ${JSON.stringify(tail)}`
}
```

这样 `index.html` 里手写的 OG / JSON-LD / favicon / `<noscript>` 全部保留，hash 化的 `assets/index-*.js|css` 也自动跟着客户端构建走，不需要维护 manifest。
`index.html` 只需加两个注释标记，把 SEO 区块包起来，服务端整段替换：

```html
<!--ssr-head-start-->
<title>…</title>
<meta name="description" …>
…canonical / og / twitter / JSON-LD…
<!--ssr-head-end-->
```

### 5.4 路由白名单

在 `src/ssr/routes.ts` 里声明（**唯一新增的路由相关文件**，不改 `routes.tsx`）：

| 路径 | SSR | 取数 | 缓存 |
| --- | --- | --- | --- |
| `/` | ✅ | `/api/matches?poolType=mixed` | 60s + swr 600s |
| `/results` | ✅ | `/api/results` | 60s + swr 600s |
| `/history` | ✅ | `/api/history?pageNo=1`（首屏 30 期）+ `/api/analysis/lottery?kind=prediction` | 120s |
| `/history-analysis` | ✅ | `/api/analysis/lottery` | 300s |
| `/math-trend-analysis` | ✅ | `/api/analysis/lottery` | 300s |
| `/horoscope` | ✅ | `/api/horoscope`（天气留客户端，服务端不知道用户 IP） | 600s |
| `/about` | ✅ | 无 | 86400s |
| `/match/:id` | ✅ | `/api/match-detail?matchId=` | 120s + swr 600s |
| `/login`、`/my-bets`、`/account`、`/profile`、`/auth/wechat` | ❌ | — | `private, no-store` |

未命中的路径：**返回 404 + `noindex`**（现在 `KeepAliveRoutes` 是 `<Navigate to="/" replace>`，SSR 下会渲染成「首页内容 + 200」，属于软 404，必须单独处理）。尾斜杠 301 到无斜杠。

### 5.5 服务端取数

**只改一个文件**就能让现有 `api/*.ts` 在服务端跑通：

```ts
// src/api/base.ts
const browserBase = import.meta.env.VITE_API_BASE ?? ''
const serverBase = typeof process !== 'undefined' ? (process.env.SSR_API_ORIGIN ?? '') : ''
export const API_BASE = String(serverBase || browserBase).replace(/\/+$/, '')
```

- `SSR_API_ORIGIN` 默认 `https://ticai-service.vercel.app`；本地预览设 `http://127.0.0.1:3001`。
- `matchService` / `resultsApi` / `historyService` / `analysisApi` 等**业务函数一行不改**，`src/ssr/loaders.ts` 直接调它们。
- 取数并行（`Promise.all`），单请求 `timeoutMs: 2500`；任一失败 → 该块降级为空、状态码仍 200、`Cache-Control` 换成 `no-store`，让下一次请求重算。
- 服务端 fetch 没有 `Origin` 头，API 的 CORS 白名单不会拦；跨项目调用与 API 同区（默认 `iad1`），多一跳约 10–30ms。

### 5.6 注水：让首帧 HTML 与首帧 React 完全一致

这是整个改造**最容易翻车**的一步。规则是：**服务端取到的数据必须在 `hydrateRoot` 之前同步落到组件能读到的地方**，否则首帧不一致，React 会丢掉整棵 SSR 树重渲染（抖动 + 控制台报错）。

```ts
// src/ssr/bootstrap.ts
let current: SsrPayload | null = null

export function setSsrPayload(payload: SsrPayload | null) { current = payload }
export function getSsrPayload() { return current }

/** 首帧读一次就删，避免后续导航复用旧快照 */
export function useSsrData<T>(key: string, fallback: T): T {
  const value = current?.data[key]
  if (value !== undefined && current) delete current.data[key]
  return (value as T) ?? fallback
}
```

落地到具体页面：

- **`matchStore`**：`entry-client` 里先 `useMatchStore.getState().hydrateFromSsr(payload.data.matches)`（新增一个 action），再 hydrate。`HomePage` 首帧就从 store 里拿到 `cards`，与 SSR 一致；`fetched: true` 还顺带省掉一次重复请求。
- **`ResultsPage` / `HistoryPage`**：把 `useState(initialState)` 换成 `useState(() => useSsrData('results', initialState))` 之类的初始化函数（**不能**在 effect 里补，effect 跑在 hydration 之后）。
- **`useAnalysisSnapshot`**：初始 state 从 `useSsrData('snapshot:' + kind, ...)` 取，`loading` 同步为 `false`。
- **`dataAsOf` 文案**：`formatDataAsOf()` 用的是 `Date.now()`，服务端和客户端差几百毫秒就会不一致。payload 里带 `renderedAt`，首帧用它算相对时间，`useEffect` 之后再切回真实时间。

### 5.7 Meta 与 JSON-LD

`src/features/seo/seo.ts` 现在混了两件事，拆开：

```ts
export function resolvePageMeta(path, data): { title; description; canonical; robots; jsonLd? }  // 纯函数
export function applyPageMeta(path, override?) // 客户端 DOM 版，内部调 resolvePageMeta
```

- 服务端：`resolvePageMeta` → 生成标签 → 替换 `<!--ssr-head-start-->…<!--ssr-head-end-->`。
- 客户端：`App` 里的 `useEffect` 保留（客户端导航仍需要），首帧不要重复写，避免无谓的 head 变动。
- `/match/:id` 产出 `SportsEvent` JSON-LD（主客队、时间、赛事），这是长尾页拿富摘要的关键。
- canonical 统一由 `SITE_URL + path` 生成，`SITE_URL` 支持 `APP_ORIGIN` 环境变量覆盖。

### 5.8 缓存

| 场景 | Cache-Control |
| --- | --- |
| 公开数据页 | `public, s-maxage=60, stale-while-revalidate=600` |
| 公开静态页（`/about`） | `public, s-maxage=86400` |
| 详情页 | `public, s-maxage=120, stale-while-revalidate=600` |
| 私有页 | `private, no-store` |
| 降级壳 / 出错 | `no-store` |

SSR 的 HTML **永远不包含用户身份**（token 在 localStorage），所以公开页可以放心走 CDN 共享缓存——这是这套架构最舒服的地方。

### 5.9 时区与 hydration

- 函数环境变量设 `TZ=Asia/Shanghai`。
- 所有 `toLocaleString / toLocaleTimeString` 显式传 `timeZone: 'Asia/Shanghai'`，否则服务端 UTC、客户端 +08:00 一定不一致。
- `shanghaiToday()` 是「UTC + 8h 再取日期」，与时区无关，安全。
- 渲染里禁止 `Math.random()`、`Date.now()` 直接进 DOM、`typeof window` 分支出不同结构。

### 5.10 降级开关

- `SSR_MODE=off` → 函数直接返回 `dist/client` 的空壳（等价今天的 `spa.html`），一行环境变量回滚，不用重新部署。
- `?ssr=off` 只用于排障，不对外承诺。
- 渲染异常 `try/catch` → 返回空壳 + `no-store`，**不要吐 500**：首页 500 对 SEO 的伤害比空壳大得多。

### 5.11 部署

改成**手写 Build Output API**，不再调 `vercel build`（现在 `framework: vite` + `buildCommand: ''` + 事后覆盖 static 的写法已经比较绕，加了函数以后更难保证一致）：

```
.vercel/output/config.json
{
  "version": 3,
  "routes": [
    { "handle": "filesystem" },
    { "src": "/api/(.*)", "dest": "https://ticai-service.vercel.app/api/$1" },
    { "src": "/(.*)",     "dest": "/ssr?p=/$1" }
  ]
}
```

- `functions/ssr.func/.vc-config.json`：`{"runtime":"nodejs20.x","handler":"index.mjs","launcherType":"Nodejs","shouldAddHelpers":false,"memory":1024,"maxDuration":30}`
- `deploy-local.mjs` 里原来的 `vercel build` 换成 `writeVercelOutput(stage)`，其余（`vercel deploy --prebuilt --prod`、临时目录、`.env` 清理）不动。
- `vercel.json` 与 `config.json` 的路由抽到 `scripts/vercel-config.mjs` 单一来源，避免两处漂移。
- 环境变量：`SSR_MODE`、`SSR_API_ORIGIN`、`TZ`、`APP_ORIGIN`。
- 入口路径用 `?p=` 传原路径（`$1` 捕获）。实现时先 `curl -i` 验证 Vercel 是否另外注入了 `x-vercel-original-path`，有就优先用 header，两种都行。

### 5.12 本地联调

- `npm run dev` 保持现状（纯 SPA，HMR 最快），SSR 不进日常开发循环。
- 新增 `npm run preview:ssr`：`node scripts/ssr-server.mjs`，用 `dist/client` + `dist/server` 起一个 Node 服务，`/api` 代理到 3001，行为和线上函数一致。SSR 的验收全部在这上面做。

## 6. 改动清单

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `src/entry-server.tsx` | 新增 | `renderToString` + 注入 + 降级 |
| `src/ssr/bootstrap.ts` | 新增 | payload 读写 / `takeSsrData` |
| `src/ssr/loaders.ts` | 新增 | 8 条路由的取数（P1 先空实现） |
| `src/ssr/html.ts` | 新增 | 模板拼接 + meta 注入 + JSON 转义 |
| `src/ssr/routes.ts` | 新增 | SSR 白名单 / 路径归一 |
| `src/ssr/virtual.d.ts` | 新增 | 虚拟模块类型声明 |
| `src/api/env.ts` | 新增 | 服务端 `serverEnv()` |
| `vite.config.server.ts` | 新增 | SSR 构建 + 模板虚拟模块 |
| `scripts/build.mjs` | 新增 | 双构建 + 产物校验 |
| `scripts/ssr-server.mjs` | 新增 | 本地 preview（等价线上函数） |
| `scripts/ssr-check.mjs` | 新增 | hydration / meta 冒烟检查 |
| `scripts/vercel-config.mjs` | 新增 | 路由单一来源（P3） |
| `scripts/prerender.mjs` | 删除 | 被 SSR 取代（P4） |
| `scripts/deploy-local.mjs` | 改 | 组装 `.vercel/output`（P3） |
| `src/main.tsx` | 改 | `hydrateRoot` / `createRoot` 二选一 + 注水 |
| `src/api/base.ts` | 改 | 服务端绝对 base |
| `src/features/seo/seo.ts` | 改 | 拆出 `resolvePageMeta()` 纯函数 |
| `src/store/matchStore.ts` | 改 | 加 `hydrateFromSsr`（P2） |
| `src/pages/{Home,Results,History,HistoryAnalysis,MathTrend,Horoscope,MatchDetail}Page.tsx` | 改 | 首帧注水 + 时间显示（P2/P3） |
| `index.html` | 改 | 加 `<!--ssr-head-*-->` 标记 |
| `vercel.json` / `package.json` / `.env.example` | 改 | 路由、脚本、环境变量 |

`playwright` 依赖**不要删**——`apps/crawler` 的阵容链路还在用，只删 `prerender.mjs` 对它的引用。

## 7. 分阶段计划

| 阶段 | 内容 | 验收 | 工期 |
| --- | --- | --- | --- |
| P0 决策与 spike | 确认目标指标；写一个最小 `entry-server` 渲染 `/about`，验证 Vite 8（Rolldown）+ React 19 + 全局 Sass 能出 SSR bundle | `node -e` 渲染出字符串、无报错 | 0.5d |
| P1 双构建骨架 | `entry-*`、虚拟模板、`build.mjs`、`ssr-server.mjs`，只 SSR `/about` | `curl` 到带正文的 `/about` | 1d |
| P2 公开页 + meta + 注水 | loaders、`resolve-meta`、`bootstrap`、7 个页面首帧改造、时区/相对时间 | 每页 view-source 有正文和 meta；控制台无 hydration 警告 | 1.5–2d |
| P3 详情页 + 部署 | `/match/:id`、404 语义、比赛 sitemap、`.vercel/output` 组装、环境变量、灰度开关 | 线上 `curl -A Googlebot` 通过；部署脚本一次成功 | 1.5d |
| P4 收尾与灰度 | 删预渲染、文档/架构图、观测、GSC 验证 | 见第 9 节 | 1d |

**灰度方式**：`config.json` 里可以按路径逐条切换 —— 先只把 `/about`、`/results` 打到 `/ssr`，其它继续读旧的 `dist/prerender/*.html`；稳定后再全量。这样出问题时影响面只有一条路由。

## 8. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| hydration 不一致（时间/时区/随机/环境分支） | 白屏抖动、控制台报错、SSR 白干 | `TZ` 固定、时间格式统一、首帧只用 payload、CI 跑一次「SSR HTML vs 客户端首帧」对比 |
| 取数失败导致首页空白 | 最坏情况比现在还差 | 2.5s 超时 + 每块独立降级 + 空壳兜底 + `SSR_MODE=off` 一键回滚 |
| 函数冷启动 | 首次访问 1–2s | 单文件 bundle、CDN `s-maxage`、部署后 cron 预热首页 |
| 部署链路变复杂（静态 + 函数） | 发布失败或 HTML/assets 版本错位 | 用 Build Output API 一次成型、同批产物、部署后探活 `/`、`/match/:id`、`/assets/*` |
| 私有页被缓存 / 被收录 | 安全问题 + 脏索引 | 只对白名单设 public 缓存；其余 `private, no-store` + `noindex` |
| 双重请求（SSR 取一次、客户端再取一次） | 浪费 API 配额 | `fetched: true` 标记 + payload 一次性消费 |
| `/history` 页面过大 | TTFB 差、带宽涨 | SSR 只渲染首屏 30 期（现有分页就是 30），翻页仍走客户端 |
| 软 404（未知路径返回首页内容） | SEO 负面 | 路由未命中 → 404 + `noindex` |
| Vercel Hobby 限制 | 函数数/时长 | 只 1 个函数，实际 < 1s；不触碰 12 个函数上限 |

## 9. 验收

```bash
# 1. 爬虫视角：不执行 JS 也能看到正文 + meta
curl -s -A "Mozilla/5.0 (compatible; Googlebot/2.1)" https://yujun426.online/ | grep -E "<title>|canonical|<h1"
curl -s -A "Mozilla/5.0 (compatible; Googlebot/2.1)" https://yujun426.online/results | grep -c "开奖"

# 2. 动态路由
curl -s -o /dev/null -w "%{http_code}\n" https://yujun426.online/match/123456     # 期望 200
curl -s -o /dev/null -w "%{http_code}\n" https://yujun426.online/match/999999999  # 期望 404
curl -s -o /dev/null -w "%{http_code}\n" https://yujun426.online/not-exist        # 期望 404

# 3. 缓存与降级
curl -sI https://yujun426.online/ | grep -i -E "cache-control|x-ssr"

# 4. 浏览器
#    - 控制台 0 条 hydration 警告
#    - 断网刷新（CDN 命中）仍能看到完整首屏
#    - 登录 / 保存投注 / AI 分析 / 历史翻页 行为与改造前一致
```

指标基线（上线前后各取一次 P75）：TTFB、LCP、函数错误率、构建时长（期望从「1–2 分钟 + 依赖 Chrome」降到 < 60s）。
Google Search Console：对 `/`、`/results`、一个 `/match/:id` 做「网址检查」，确认渲染后的 HTML 与原始 HTML 一致。

## 10. 如果只想先解决 SEO：B 方案（扩展预渲染，1 人日）

不动运行时，只把 `scripts/prerender.mjs` 用得更狠：

1. 增加 `/match/:id`：构建时从 `/api/matches` 拿当天在售比赛，逐页预渲染（每页约 1s，50 场 ≈ +50s）。
2. 生成 `sitemap-matches.xml`，并在 `robots.txt` 里声明。
3. 把预渲染失败从「静默兜底」改成「构建告警 + 明确日志」。
4. 用 `npm run prerender` + 部署脚本做每日定时刷新。

**代价**：数据仍是构建时刻的快照；构建时长随比赛数增长；页面数一多就一定不稳。
**结论**：这是「马上见效」的止血方案，适合作为 SSR 落地前的过渡，不适合作为终态。

## 11. 落地时的仓库流程（AGENTS.md）

1. 分支 `feat/ssr`，先 P0 spike，再按阶段提交。
2. 每阶段结束跑 `npm run build`、`npm run api:test`、`npm run check:secrets`。
3. 涉及数据流/部署链路变化，同步 `docs/architecture.md`（新增「SSR 渲染链路」小节）+ `npm run architecture:update`。
4. 更新 `README.md`（构建/部署说明）、`docs/SEO.md` 第 5、6 节（预渲染 → SSR），`.env.example` 补 `SSR_API_ORIGIN` / `SSR_MODE` / `TZ` / `APP_ORIGIN`。
5. 合并前确认 `pre-push` 的双端发布没有被破坏（前端现在多了函数资产，`deploy:local` 要先本地验证一次）。

## 12. 实施记录

### 2026-10-28 · P0 + P1 完成（SSR 骨架 + `/about`）

**做了什么**

- 双构建：`vite build --outDir dist/client` + `vite build --config vite.config.server.ts` → `dist/server/entry-server.mjs`；
- 模板：`vite.config.server.ts` 里的 `virtual:ssr-template` 插件在构建期把 `dist/client/index.html` 按 `<div id="app"></div>` 切成 `head` / `tail`，hash 化的 assets 地址自动跟随；
- 入口：`src/main.tsx` 按「容器里有没有子节点」决定 `hydrateRoot` 还是 `createRoot`；`src/entry-server.tsx` 导出 `renderPage()`，取数 → `renderToString(StaticRouter)` → 注入 → 返回 `{ status, ssr, cacheControl, html }`；
- 降级：渲染异常 / `SSR_MODE=off` / 非白名单路由 → 返回空壳 + `no-store`，不吐 500；
- meta：`seo.ts` 拆出纯函数 `resolvePageMeta()`，服务端与客户端共用一份规则，`index.html` 用 `<!--ssr-head-start/end-->` 标记替换区块；
- 本地预览：`scripts/ssr-server.mjs`（静态直出 + `/api` 流式代理 + SSR），行为对齐将来的线上函数；
- 冒烟检查：`scripts/ssr-check.mjs`，检查 SSR 正文、payload、meta、hydration 无告警、受控组件可交互、客户端路由后 meta 更新。

**怎么验证**

```bash
npm run build:ssr     # 双构建，约 20s
npm run preview:ssr   # http://127.0.0.1:4180
npm run ssr:check     # Playwright 冒烟，失败返回非 0
curl -s http://127.0.0.1:4180/about | grep -E "<title>|canonical"
```

**实测**

| 项 | 结果 |
| --- | --- |
| `/about` 响应 | 200，`x-ssr: hit`，本地 50ms |
| `/about` HTML | 带顶部导航 + 页面正文，`<title>关于体彩助手</title>`，canonical / robots 正确 |
| hydration | 控制台 0 error / 0 warning，`<textarea>` 受控输入正常 |
| 非 SSR 路由 `/results` | 空壳 + 正确 meta，客户端正常渲染 |
| 客户端路由切换 | title / canonical 正常更新（`applyPageMeta` 未被改坏） |
| 产物体积 | `dist/client` 1.0 MB（gzip JS 185 KB + CSS 24 KB）；`dist/server/entry-server.mjs` 2.0 MB（gzip 425 KB） |
| 现有 `npm run build` | 7/7 预渲染成功，未受影响 |

**这一阶段有意保留的边界**

1. 只有 `/about` 进白名单，其它路由仍是空壳（只是 meta 已经正确）——P2 才接数据；
2. 未命中路径仍返回 200（软 404）——P3 处理；
3. `build` 与 `build:ssr` 共用 `dist`、互相覆盖；**线上部署仍走 `npm run build`**，P3 才切换；
4. `src/ssr/loaders.ts` 还没接任何接口；`takeSsrData()` 已就绪但还没页面在用。

**下一阶段（P2）**

1. `loaders.ts` 接 `/`、`/results`、`/history`、`/history-analysis`、`/math-trend-analysis`、`/horoscope`；
2. `matchStore` 加 `hydrateFromSsr()`，`ResultsPage` / `HistoryPage` 改用 `takeSsrData()` 做首帧初始值；
3. `useAnalysisSnapshot` 初始 state 从 payload 取；
4. 相对时间统一用 `payload.renderedAt` 计算；
5. 每加一个路由，就把 `scripts/ssr-check.mjs` 的断言补上一条。

