# ticai · 体彩助手

> 中国体彩「排列五」开奖分析 + 竞彩足球赔率投注方案的 Web 应用。
> 前端 React 19 单页应用，服务端为零依赖 Node BFF；浏览器只与同源 `/api/*` 通信，第三方密钥不出服务端。

🔗 **在线预览**：https://ticai-eight.vercel.app 　（Vercel 部署，推送 `main` 自动发布）

![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A520-5fa04e?logo=nodedotjs&logoColor=white)
![License](https://img.shields.io/badge/license-unlicensed-lightgrey)

![架构图](docs/architecture.png)

> 矢量版本：[architecture.svg](docs/architecture.svg) · 文字版说明：[architecture.md](docs/architecture.md)
> 架构图由 `npm run architecture:update` 按当前文件清单生成，`pre-commit` 会自动同步。

---

## 功能

| 路由 | 页面 | 能力 |
| --- | --- | --- |
| `/` | 赛事投注 | 5 种玩法池（胜平负/比分/进球数/半全场/混合过关）、赔率勾选、首屏骨架屏、串关注数与金额、最高奖金与彩票税、方案截图、**每场比赛 / 整个方案两级 AI 分析** |
| `/history` | 开奖历史 | 排列五开奖列表、号码走势、基于本地数据的预测摘要 |
| `/history-analysis` | 分析页面 | 频次/遗漏/马尔可夫/滚动回测/组合推荐，权重与马尔可夫阶数可调 |
| `/math-trend-analysis` | 数学走势 | 线性回归趋势、预测中心、波动率、大样本回测 |
| `/horoscope` | 星座运势 | 12 星座 × 5 种时间维度 + 基于服务端 IP 定位的天气 |

设计要点：

- **Keep-Alive 路由**：页面切换后保持挂载（`display` 切换），滚动位置与输入状态不丢失。
- **重计算下沉 Worker**：预测算法在 Web Worker 中执行，主线程不卡顿，并有主线程降级路径。
- **本地优先**：开奖历史落 IndexedDB，分析类页面完全本地计算。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | React 19、React Router 6、Zustand 5、Sass、html2canvas |
| 构建 | Vite 8 + TypeScript 6（`tsc && vite build`） |
| 服务端 | Node ≥ 20 原生 ESM + `node:http`，**无第三方依赖** |
| 持久化 | IndexedDB（开奖历史）、localStorage（仅遗留迁移） |

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量（服务端密钥，不会打进前端 bundle）
cp .env.example .env
#   Windows: copy .env.example .env
#   然后填入聚合数据的 JUHE_WEATHER_KEY / JUHE_HOROSCOPE_KEY
#   如需大模型能力，再填入 DEEPSEEK_API_KEY（见「接入 DeepSeek 大模型」）

# 3. 启动开发环境（BFF:3000 + Vite:5173，/api 走代理）
npm run dev
```

> 修改 `server/` 下的代码后必须重启 `npm run dev`（BFF 没有热重载）；只刷新浏览器不会加载新的接口。
> 如果页面提示「接口不存在」，先确认当前 BFF 的启动日志里是否列出了对应路由，并重启开发进程。

打开 http://localhost:5173

生产模式（单进程、同源部署，BFF 顺带托管 `dist`）：

```bash
npm run build
npm start            # http://127.0.0.1:3000
```

| 脚本 | 作用 |
| --- | --- |
| `npm run dev` | 并行启动 BFF 与 Vite，任一退出则联动关闭 |
| `npm run dev:api` | 只启动 BFF |
| `npm run dev:web` | 只启动前端（需 BFF 已在 3000 端口） |
| `npm run build` | `tsc` 类型检查 + 产物构建 |
| `npm start` | 生产启动（BFF + 静态托管） |
| `npm run ai:check` | 直连 DeepSeek 自检密钥与模型连通性 |
| `npm run architecture:update` | 按当前文件清单重新生成 `docs/architecture.svg/.png` |
| `npm run hooks:install` | 安装提交前架构图同步 + 推送前自动部署 hooks |
| `npm run deploy:local` | 本地构建并发布 Vercel 生产环境 |

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | BFF 监听地址（默认只绑本机） |
| `SERVE_STATIC` | `1` | 是否由 BFF 托管 `dist`；反代部署可设 `0` |
| `UPSTREAM_TIMEOUT_MS` | `8000` | 上游请求超时 |
| `JUHE_WEATHER_KEY` | — | 缺失时 `/api/weather` 返回 503 |
| `JUHE_HOROSCOPE_KEY` | — | 缺失时 `/api/horoscope` 返回 503 |
| `JUHE_IP_KEY` | — | 缺失时 `/api/ip` 返回空归属地，前端回退默认城市 |
| `DEEPSEEK_API_KEY` | — | 缺失时 `/api/ai-chat` 返回 503；**不要加 `VITE_` 前缀** |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容接口地址，可指向代理/网关 |
| `DEEPSEEK_MODEL` | `deepseek-flash` | 也可用 `deepseek-v4-pro` |
| `DEEPSEEK_TIMEOUT_MS` | `60000` | 大模型上游超时 |
| `DEEPSEEK_MAX_TOKENS` | `1024` | 默认输出上限（单次请求最大 8192） |
| `DEEPSEEK_THINKING` | `0` | `1` = 默认开启思考模式（更慢更贵） |
| `AI_RATE_LIMIT_PER_MIN` | `10` | `/api/ai-chat` 每 IP 每分钟次数，`0` = 不限 |
| `VENUE_RATE_LIMIT_PER_MIN` | `20` | `/api/venue-weather` 每 IP 每分钟次数，`0` = 不限 |
| `SPORTTERY_BASE` 等 | 官方地址 | 上游地址，可指向 mock 服务离线联调 |

> 未配置聚合数据密钥时，赛事与开奖功能仍可正常使用，仅天气/星座接口不可用。

## 服务端接口

| 方法 | 路径 | 上游 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/matches` | 体彩 `getMatchCalculatorV1` | 参数 `poolType` ∈ had/crs/ttg/hafu/mixed，缓存 20s |
| GET | `/api/history` | 体彩 `getHistoryPageListV1` | 开奖历史分页，`pageSize ≤ 100`，缓存 60s |
| GET | `/api/horoscope` | 聚合数据星座 | `consName` / `type` 白名单，缓存 10min |
| GET | `/api/weather` | 聚合数据天气 | 城市名白名单校验，缓存 10min |
| GET | `/api/ip` | 聚合数据 IP | 取连接 IP，未配置密钥时降级 |
| POST | `/api/ai-chat` | DeepSeek `chat/completions` | `messages` 必填；`stream` 为 SSE；其余选项见下文 |
| GET | `/api/venue-weather` | DeepSeek 解析城市 + Open-Meteo | 参数 `homeTeam` / `league` / `kickoff` / `teamId`，结果按球队缓存 |
| GET | `/api/health` | — | 运行状态、密钥配置情况、缓存命中数 |

统一约定：参数白名单校验、上游超时 8s、错误码 `400 / 404 / 405 / 413 / 429 / 502 / 503 / 504`。

## 接入 DeepSeek 大模型

项目没有引入任何模型 SDK：`server/llm.mjs` 用 Node 原生 `fetch` 直连 DeepSeek 的
[OpenAI 兼容接口](https://api-docs.deepseek.com/)，浏览器只访问同源 `POST /api/ai-chat`。
密钥始终留在服务端进程里，前端 bundle 中不会出现。

> ⚠️ 不要使用 `VITE_DEEPSEEK_API_KEY` 之类的变量直连模型：`VITE_` 前缀的变量会被 Vite
> 打进浏览器代码，任何人打开 DevTools 都能拿到密钥并盗刷余额。

### 1. 配置密钥

在 `.env`（已被 `.gitignore` 忽略）中填写：

```bash
DEEPSEEK_API_KEY=sk-xxxxxxxx
```

其余可选配置见上方[环境变量](#环境变量)。默认模型为 `deepseek-flash`，并**关闭思考模式**
（DeepSeek 默认开启思考，交互式场景会明显更慢、更贵；需要深度分析时设置 `DEEPSEEK_THINKING=1`
或在单次请求里传 `thinking: true`。开启思考且未指定 `maxTokens` 时，服务端会把默认上限提高到 4096，
因为推理 token 也计入 `max_tokens`）。

### 2. 验证密钥

```bash
npm run ai:check                 # 直接用默认提示词试一次
npm run ai:check 用一句话介绍竞彩足球
```

脚本会打印模型回复、耗时和 token 用量；密钥错误、余额不足、超时都会给出明确提示。

### 3. 前端调用

```ts
// 以 src/pages 下的页面为例
import { askAi, askAiText } from '../api/aiApi'

// 单轮：适合"AI 解读""生成摘要"
const summary = await askAiText('用 200 字解读这场比赛的赔率变化', {
  system: '你是竞彩足球分析师，只做客观解读，不给出投注建议。',
  maxTokens: 512,
})

// 多轮：自己维护 messages 数组
const { content, usage } = await askAi({
  messages: [
    { role: 'system', content: '你是一个简洁的中文助手。' },
    { role: 'user', content: '排列五的号码可以预测吗？' },
  ],
  temperature: 0.3,
})
```

返回值：`{ content, reasoning, model, finishReason, truncated, usage, elapsedMs }`。
请求失败会抛 `ApiError`（状态码见 `httpClient.ts`），可直接在页面里提示。

### 4. HTTP 调用

```bat
:: Windows 自带的 curl.exe（PowerShell 里 curl 是 Invoke-WebRequest 的别名）
curl.exe -X POST http://127.0.0.1:3000/api/ai-chat ^
  -H "content-type: application/json" ^
  -d "{\"messages\":[{\"role\":\"user\",\"content\":\"用一句话介绍你自己\"}]}"
```

```powershell
# PowerShell 原生写法
Invoke-RestMethod -Uri http://127.0.0.1:3000/api/ai-chat -Method Post `
  -ContentType 'application/json' `
  -Body (@{ messages = @(@{ role = 'user'; content = '用一句话介绍你自己' }) } | ConvertTo-Json -Depth 5)
```

请求字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `messages` | `{ role, content }[]` | 必填，`role` ∈ `system` / `user` / `assistant`，最多 40 条 |
| `temperature` | `number` | 可选，`0 ~ 2` |
| `maxTokens` | `number` | 可选，`1 ~ 8192`；默认取 `DEEPSEEK_MAX_TOKENS`（开启思考时至少 4096） |
| `json` | `boolean` | 可选，要求只输出 JSON；提示词中必须包含 "json" 字样 |
| `thinking` | `boolean` | 可选，覆盖服务端默认的思考模式开关 |
| `reasoningEffort` | `'none' \| 'low' \| 'high' \| 'max'` | 可选，思考强度；`none` 等价于关闭 |
| `stream` | `boolean` | 可选，`true` 时以 SSE 返回思考过程与正文增量 |

响应沿用 BFF 信封：`{ success: true, data: { content, ... } }`；失败为 `{ success: false, errorMessage }`。
`stream: true` 时改为 SSE，事件为 `reasoning` / `content`（`data: { delta }`）、`done`（用量与耗时）和 `error`。

### 5. 比赛 AI 分析（页面功能）

赛事投注页每场比赛右上角都有「AI 分析」按钮：

- 按**当前玩法**（胜平负/比分/进球数/半全场/混合）生成针对性预测，而不是泛泛而谈；
- 分析维度固定为状态与风格、阵容与伤停、主客场与赛程、天气、赔率，最后给出推荐选项、比分参考与信心等级；
- 浮层内先展示「分析过程」，再展示「预测结果」，支持复制、重新分析；桌面端浮在按钮左侧，移动端为底部抽屉；
- 同一玩法 + 同一场比赛的结果会在当前页面会话内缓存，重复打开不重复扣费；
- 关闭浮层会立即中断 SSE 与上游 DeepSeek 请求；比赛地天气最多等待 15s，超时则跳过天气直接分析。

方案弹层右上角还有**方案级 AI 分析**：只把当前方案里已选的场次、选项与赔率发给模型，逐场判断所选选项，
再评估串关的关联风险、关键短板与整体信心；同样走 SSE，并按「玩法 + 已选场次 + 选项」缓存。
方案快照支持 3～4 倍高清导出，只截白色弹框；截图副本会隐藏 AI / 截图 / 关闭操作，并额外带上当前玩法、
倍数、投注金额与最高奖金，正常弹层不展示这些附加信息。

实现上，前端通过 `POST /api/ai-chat`（`stream: true`）消费 SSE，服务端边收 DeepSeek 增量边转发；
提示词明确要求「无法确认阵容/伤情时必须写暂无可靠信息」，避免模型编造首发和伤病名单。

天气取的是**比赛地天气**：先由 `GET /api/venue-weather` 让 DeepSeek 根据「主队 + 联赛」解析主场城市，
再用免费的 [Open-Meteo](https://open-meteo.com/) 取当地当前天气与开赛时段预报（无需额外密钥）。
城市解析按球队缓存 7 天，天气按坐标缓存 20 分钟；无法确认城市时返回 `available: false`，
界面显示「比赛地天气未获取」，提示词要求模型直接说明缺失，不会拿其它城市的数据凑数。

### 6. 限制与注意事项

- **限流**：`/api/ai-chat` 默认每 IP 每分钟 10 次，`/api/venue-weather` 默认 20 次（均为进程内内存实现），可分别通过 `AI_RATE_LIMIT_PER_MIN` / `VENUE_RATE_LIMIT_PER_MIN` 调整；
- **长度**：单条消息 ≤ 15000 字符，整段对话 ≤ 30000 字符，请求体 ≤ 256 KB；
- **超时**：服务端默认 60s，前端 70s；Vercel 函数已在 `vercel.json` 单独放开到 60s；
- **公网部署**：`/api/ai-chat` 没有登录鉴权，任何人都能借你的密钥消耗余额。公开前请加登录、
  网关限流或改用带鉴权的后端；本项目的默认监听地址 `127.0.0.1` 只适合本机使用；
- **流式输出**：`stream: true` 已支持，BFF 用 SSE 转发 DeepSeek 的增量；比赛 AI 分析默认走这条链路。
  注意 Vercel 函数需保持在 `maxDuration` 以内，且反向代理不能缓冲 `text/event-stream`。

## 密钥与本地文件

真实密钥只放在项目根目录的 `.env`（已被 `.gitignore` 忽略，不会进入 Git）：

```bash
DEEPSEEK_API_KEY=sk-...
JUHE_WEATHER_KEY=...
JUHE_HOROSCOPE_KEY=...
```

> 当前仓库的工作区、全部 Git 历史与不可达对象均已扫描，没有真实密钥；`.env` 从未被 Git 跟踪。

- `.env.example` 只保留空占位，可安全提交；
- `npm run check:secrets` 会扫描暂存区，发现 `sk-`、32 位聚合密钥、GitHub/Vercel token 时阻止提交；
- `.git/hooks/pre-commit` 已安装该检查（本地 hook，不进入仓库）；
- `.vercelignore` 排除了 `.env`、`.vercel`、`resume/`，本地部署不会上传这些文件；
- 部署脚本设置 `functions.excludeFiles`，并在打包后清理 `.vercel/output/functions/**/.env`，避免密钥被复制进函数产物；
- `vercel pull` 会把生产变量写到 `.vercel/.env.production.local`（已忽略）；不要分享或打包 `.vercel` 目录；
- 密钥如果曾出现在提交、截图或聊天记录中，请到对应平台轮换。

## 部署到 Vercel（本地构建）

Vercel 上没有常驻进程，因此 BFF 在线上以 **Serverless Functions** 运行：`api/*.js` 只是薄适配层，直接复用 `server/handlers.mjs` 的实现，本地与线上逻辑不会分叉。

项目已经关闭 Vercel 的 Git 自动构建：`vercel.json` 中 `git.deploymentEnabled` 为 `false`。
发布改为 **本地构建 + 上传预构建产物**，云端只托管、不构建，也不会上传源码和 `.env`。

| 文件 | 作用 |
| --- | --- |
| `api/matches.js` 等 8 个 | 每行一个 `createRouteHandler('xxx')`，对应 `/api/*` 路径 |
| `api/_shared.js` | 复用 handler、解析 URL、方法校验、统一错误出口（`_` 前缀不会被注册成路由） |
| `vercel.json` | Vite 构建、SPA fallback、`/assets` 长缓存、函数内存与超时、关闭 Git 自动部署 |
| `.vercelignore` | 本地部署时排除 `.env`、`resume/` 等文件 |

### 第一次配置

1. 在 Vercel 控制台 **Add New → Project** 导入 `yJ2018/ticai`（如果还没导入）；
2. 在 **Settings → Environment Variables** 添加（Production / Preview 都建议加）：

   | Key | 说明 |
   | --- | --- |
   | `JUHE_WEATHER_KEY` | 聚合数据天气密钥 |
   | `JUHE_HOROSCOPE_KEY` | 聚合数据星座密钥 |
   | `JUHE_IP_KEY` | 可选，IP 归属地 |
   | `DEEPSEEK_API_KEY` | 可选，`/api/ai-chat` 与比赛地城市解析的大模型密钥（不要加 `VITE_` 前缀） |
   | `VITE_SPORTTERY_DIRECT` | **云端部署建议设为 `1`**，见下方说明 |

   > 不配置前三个也能部署成功，只是天气/星座返回 503，其余功能正常。

   **关于 `VITE_SPORTTERY_DIRECT`**：体彩接口会对云厂商出口 IP 返回 `HTTP 567`（Vercel 的 Node 函数 `iad1`/`hkg1` 与 Edge 运行时都会被拦），因此云端部署必须把它设为 `1`，让浏览器直连 `webapi.sporttery.cn`；该接口不需要密钥、返回 `Access-Control-Allow-Origin: *`。不设置时走同源 `/api/*`，适合部署在出口不被拦的环境（例如境内服务器）。

   > ⚠️ 已知限制：浏览器直连时，体彩「开奖历史」接口对**海外出口**会返回不带 CORS 头的 WAF 挑战页。若访问本站走了全局代理，赛事投注正常、开奖历史可能加载失败；把 `*.sporttery.cn` 加入代理白名单（直连）即可。

3. 本地登录 Vercel（只需一次）：

   ```bash
   npx vercel login
   npm run hooks:install   # 安装提交前架构图同步 + 推送前自动发布 hooks
   ```

   部署脚本内置本项目的 `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`，通过临时目录构建，
   不依赖仓库根 `.vercel`；如项目迁移，可用同名环境变量覆盖。

### 发布

```bash
npm run deploy:local
```

脚本依次执行：

1. 强制 `VITE_SPORTTERY_DIRECT=1` 后执行 `npm run build`：本地构建 Vite 静态资源，让线上浏览器直连体彩接口（Vercel 出口 IP 会被体彩 WAF 拦截）；
2. 检查产物 bundle 中确实存在 `webapi.sporttery.cn`，否则中止发布；
3. 在系统临时目录创建隔离构建目录，复制 `api/`、`server/`、`dist/` 和最小 `package.json`；
4. 用 `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` 执行 `vercel build --prod`，生成预构建函数产物；
5. 用 `dist` 替换 `.vercel/output/static`：避免 Vercel 把 `src/`、`server/` 源码当成静态文件发布，也保证 `index.html` 指向 hashed assets；
6. `vercel deploy --prebuilt --prod`：只上传 `.vercel/output`，不上传源码与 `.env`；
7. 清理临时目录（Windows 上偶尔被 CLI 短暂占用，清理失败不会影响已完成的部署）。

> 如果访问线上站点时要求登录 Vercel，检查项目 **Settings → Deployment Protection**。
> 当前项目是 `all_except_custom_domains`，`*.vercel.app` 的生产域名也会被保护；需要公开访问时要改成只保护 Preview 或关闭。

### 推送自动发布 + 架构图同步

hook 源文件在 `scripts/git-hooks/`（已进入仓库），克隆后执行一次：

```bash
npm run hooks:install
```

- `pre-commit`：自动运行 `architecture:update`，生成 `docs/architecture.svg/.png` 并加入本次提交，然后扫描密钥；
- `pre-push`：推送到 `main` 时先本地构建并发布，默认发布失败**不阻止**推送。

```bash
git push                    # 自动本地构建 + 发布
SKIP_DEPLOY=1 git push      # 本次跳过发布
DEPLOY_STRICT=1 git push    # 发布失败则阻止推送
```

Hook 只对 `main` 生效；工作区有未提交改动时会跳过部署，避免发布内容和提交内容不一致。
由于是 `pre-push`，发布发生在推送之前；如果推送被拒绝（例如 non-fast-forward），生产可能已经更新，重试推送即可。
架构图只自动反映文件清单与分层；涉及数据流/接口职责的改动仍需同步更新 `docs/architecture.md` 的 Mermaid 与文字说明。
如果 Vercel 控制台的 Git 集成仍在触发构建，请在 **Settings → Git** 断开集成，或确认 `git.deploymentEnabled: false` 已生效。

本地预览（不发布）：

```bash
npx vercel dev
```

## 目录结构

```text
.
├─ api/                     # Vercel Serverless Functions（复用 server/ 的实现）
├─ server/                  # 零依赖 Node BFF
│  ├─ index.mjs             # HTTP 服务、路由分发、静态托管、SPA fallback
│  ├─ handlers.mjs          # /api/* 实现（白名单、缓存、错误映射）
│  ├─ llm.mjs               # DeepSeek 客户端（OpenAI 兼容，原生 fetch）
│  ├─ venue.mjs             # 主队城市解析 + Open-Meteo 比赛地天气
│  └─ lib.mjs               # .env 解析、TTL 缓存、超时 fetch、JSON body、静态文件
├─ scripts/
│  ├─ dev.mjs               # 并行拉起 BFF + Vite
│  ├─ ai-smoke.mjs          # npm run ai:check 密钥连通性自检
│  ├─ check-secrets.mjs     # 提交前扫描暂存区密钥
│  ├─ update-architecture.mjs # 按文件清单生成架构图 SVG / PNG
│  ├─ install-git-hooks.mjs # 安装 pre-commit / pre-push hooks
│  ├─ git-hooks/            # hook 源文件（进仓库）
│  └─ deploy-local.mjs      # 临时目录构建 + Vercel 预构建部署
├─ AGENTS.md                # push 前自动流程与 hook 约定
├─ vercel.json              # Vercel 构建、路由与关闭云端自动部署
├─ src/
│  ├─ pages/                # 7 个页面
│  ├─ features/betting/     # 投注单：useBetSlip + 纯函数 + 组件 + 两级 AI 分析
│  │  ├─ MatchListSkeleton.tsx   # 首屏一屏骨架屏
│  │  ├─ AiAnalysisPanel.tsx     # 单场 AI 浮层 / 移动端抽屉
│  │  ├─ useMatchAiAnalysis.ts   # 单场 SSE 状态机、天气、结果缓存
│  │  ├─ ParlayAiAnalysisPanel.tsx # 方案级逐场 / 串关风险面板
│  │  └─ useParlayAiAnalysis.ts  # 串关 SSE 状态机 + 方案缓存
│  ├─ components/           # 通用控件（如自绘下拉 MarkovOrderSelect）
│  ├─ router/               # 自研 Keep-Alive 路由
│  ├─ service/              # 业务服务（历史缓存状态机、赔率映射等）
│  ├─ storage/historyDb.ts  # IndexedDB 仓储（增量写、按序裁剪）
│  ├─ domain/               # 纯类型与纯函数算法（含 1064 行预测算法）
│  ├─ api/                  # 传输层（aiApi、venueWeatherApi、统一错误）
│  └─ workers/              # 2 个预测计算 Worker
└─ docs/                    # 架构文档与架构图
```

## 数据与缓存

- **IndexedDB**（`ticai` 库）：`history_meta` 存同步元数据，`history_draws` 每条开奖一条记录；只写新增条目，超过 2 万条按开奖期号裁剪最旧记录；旧版 `localStorage` 缓存会自动迁移。IndexedDB 不可用时降级为纯内存。
- **BFF 内存缓存**：按接口设置 TTL（20s ~ 30min；比赛地城市解析缓存 7 天、天气 20min），降低上游压力。
- **前端请求**：统一 15s 超时 + `AbortController`，切换页面时自动取消。

## 已知限制

- BFF **没有鉴权**，默认只监听 `127.0.0.1`；`/api/ai-chat` 有单实例内存限流，但对外暴露前仍应置于网关之后或自行加鉴权。
- 聚合数据接口需要自行申请密钥，免费额度有限。
- AI 分析的阵容/伤停来自模型自身知识，可能滞后或缺失；提示词要求无法确认时明确说明，但仍应以官方赛前名单为准。
- 比赛地城市由模型解析（冷门球队可能解析失败或出错），失败时接口返回 `available: false`，分析会注明天气缺失；天气为 Open-Meteo 预报，开赛时段按小时对齐，存在一定误差。
- 两个分析页（`HistoryAnalysisPage`、`MathTrendAnalysisPage`）仍未拆分，且 `HistoryPage` 的算法在主线程同步执行。
- 本地自动发布依赖 Vercel CLI 登录；hook 源文件已在仓库中，克隆后执行 `npm run hooks:install` 即可恢复。部署使用临时目录和项目 ID，不需要仓库根 `.vercel`。
- 架构图由脚本按文件清单自动生成；语义变化（数据流、接口职责）仍需人工补充 `docs/architecture.md`。
- 移动端在 430px 以下存在轻微横向溢出。
- 项目暂无单元测试与 ESLint 配置。

## 致谢与声明

本项目仅用于个人学习与技术实践，数据来源于中国体彩与聚合数据的公开接口，请遵守相关服务条款。不构成任何投注建议。
