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

---

## 功能

| 路由 | 页面 | 能力 |
| --- | --- | --- |
| `/` | 赛事投注 | 5 种玩法池（胜平负/比分/进球数/半全场/混合过关）、赔率勾选、串关注数与金额、最高奖金与彩票税、方案截图 |
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

# 3. 启动开发环境（BFF:3000 + Vite:5173，/api 走代理）
npm run dev
```

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

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | BFF 监听地址（默认只绑本机） |
| `SERVE_STATIC` | `1` | 是否由 BFF 托管 `dist`；反代部署可设 `0` |
| `UPSTREAM_TIMEOUT_MS` | `8000` | 上游请求超时 |
| `JUHE_WEATHER_KEY` | — | 缺失时 `/api/weather` 返回 503 |
| `JUHE_HOROSCOPE_KEY` | — | 缺失时 `/api/horoscope` 返回 503 |
| `JUHE_IP_KEY` | — | 缺失时 `/api/ip` 返回空归属地，前端回退默认城市 |
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
| GET | `/api/health` | — | 运行状态、密钥配置情况、缓存命中数 |

统一约定：参数白名单校验、上游超时 8s、错误码 `400 / 404 / 405 / 502 / 503 / 504`。

## 部署到 Vercel

Vercel 上没有常驻进程，因此 BFF 在线上以 **Serverless Functions** 运行：`api/*.js` 只是薄适配层，直接复用 `server/handlers.mjs` 的实现，本地与线上逻辑不会分叉。

| 文件 | 作用 |
| --- | --- |
| `api/matches.js` 等 6 个 | 每行一个 `createRouteHandler('xxx')`，对应 `/api/*` 路径 |
| `api/_shared.js` | 复用 handler、解析 URL、方法校验、统一错误出口（`_` 前缀不会被注册成路由） |
| `vercel.json` | Vite 构建、SPA fallback、`/assets` 长缓存、函数内存与超时 |

部署步骤：

1. 在 Vercel 控制台 **Add New → Project** 导入 `yJ2018/ticai`，框架会自动识别为 Vite；
2. 在 **Settings → Environment Variables** 添加（Production / Preview 都建议加）：

   | Key | 说明 |
   | --- | --- |
   | `JUHE_WEATHER_KEY` | 聚合数据天气密钥 |
   | `JUHE_HOROSCOPE_KEY` | 聚合数据星座密钥 |
   | `JUHE_IP_KEY` | 可选，IP 归属地 |
   | `VITE_SPORTTERY_DIRECT` | **云端部署建议设为 `1`**，见下方说明 |

   > 不配置前三个也能部署成功，只是天气/星座返回 503，其余功能正常。

   **关于 `VITE_SPORTTERY_DIRECT`**：体彩接口会对云厂商出口 IP 返回 `HTTP 567`（Vercel 的 Node 函数 `iad1`/`hkg1` 与 Edge 运行时都会被拦），因此云端部署必须把它设为 `1`，让浏览器直连 `webapi.sporttery.cn`；该接口不需要密钥、返回 `Access-Control-Allow-Origin: *`。不设置时走同源 `/api/*`，适合部署在出口不被拦的环境（例如境内服务器）。

   > ⚠️ 已知限制：浏览器直连时，体彩「开奖历史」接口对**海外出口**会返回不带 CORS 头的 WAF 挑战页。若访问本站走了全局代理，赛事投注正常、开奖历史可能加载失败；把 `*.sporttery.cn` 加入代理白名单（直连）即可。

3. 部署完成后，**Git 集成默认已开启**：推送到 `main` 会自动构建并发布 Production，其它分支生成 Preview 部署；
4. 如需从外部触发（CI、定时任务、其它仓库），可在 **Settings → Git → Deploy Hooks** 创建 Hook：

   ```bash
   curl -X POST "https://api.vercel.com/v1/integrations/deploy/<hook-id>"
   ```

本地也可以用 Vercel CLI 预演：

```bash
npx vercel dev          # 同时跑静态站与 api/*.js，读取 .env
npx vercel --prod       # 手动发布一次
```

## 目录结构

```text
.
├─ api/                     # Vercel Serverless Functions（复用 server/ 的实现）
├─ server/                  # 零依赖 Node BFF
│  ├─ index.mjs             # HTTP 服务、路由分发、静态托管、SPA fallback
│  ├─ handlers.mjs          # /api/* 实现（白名单、缓存、错误映射）
│  └─ lib.mjs               # .env 解析、TTL 缓存、超时 fetch、静态文件
├─ scripts/dev.mjs          # 并行拉起 BFF + Vite
├─ vercel.json              # Vercel 构建与路由配置
├─ src/
│  ├─ pages/                # 7 个页面
│  ├─ features/betting/     # 投注单：useBetSlip + 纯函数 + 4 个组件
│  ├─ router/               # 自研 Keep-Alive 路由
│  ├─ service/              # 业务服务（历史缓存状态机、赔率映射等）
│  ├─ storage/historyDb.ts  # IndexedDB 仓储（增量写、按序裁剪）
│  ├─ domain/               # 纯类型与纯函数算法（含 1064 行预测算法）
│  ├─ api/                  # 传输层（超时、统一错误）
│  └─ workers/              # 2 个预测计算 Worker
└─ docs/                    # 架构文档与架构图
```

## 数据与缓存

- **IndexedDB**（`ticai` 库）：`history_meta` 存同步元数据，`history_draws` 每条开奖一条记录；只写新增条目，超过 2 万条按开奖期号裁剪最旧记录；旧版 `localStorage` 缓存会自动迁移。IndexedDB 不可用时降级为纯内存。
- **BFF 内存缓存**：按接口设置 TTL（20s ~ 30min），降低上游压力。
- **前端请求**：统一 15s 超时 + `AbortController`，切换页面时自动取消。

## 已知限制

- BFF **没有鉴权与限流**，默认只监听 `127.0.0.1`；对外暴露前请置于网关之后或自行加限流。
- 聚合数据接口需要自行申请密钥，免费额度有限。
- 两个分析页（`HistoryAnalysisPage`、`MathTrendAnalysisPage`）仍未拆分，且 `HistoryPage` 的算法在主线程同步执行。
- 移动端在 430px 以下存在轻微横向溢出。
- 项目暂无单元测试与 ESLint 配置。

## 致谢与声明

本项目仅用于个人学习与技术实践，数据来源于中国体彩与聚合数据的公开接口，请遵守相关服务条款。不构成任何投注建议。
