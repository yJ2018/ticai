# ticai · 体彩助手

> 竞彩足球赔率投注 + 体彩开奖分析（排列5 / 七星彩 / 超级大乐透）+ 可选账号与投注记录。
>
> 前端 **Next.js 16**（App Router，公开页按请求 SSR），服务端拆成三个独立项目：
> **`apps/api`**（Node）只读数据库、对外 REST + SSE，并把分析类接口反向代理到 Python；
> **`apps/analysis`**（Python / FastAPI）计算全部分析（推荐 / 开奖 / 走势 / 大乐透 / 天气 / AI）；
> **`apps/crawler`** 在本机抓体彩（和 500.com 的阵容）写入数据库。
> 浏览器只与自有 API 通信（同源 `/api` rewrite），第三方密钥、提示词与上游访问全部留在服务端。

🔗 在线预览 <https://yujun426.online> ｜ 接口健康检查 <https://ticai-service.vercel.app/healthz>

![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A520-5fa04e?logo=nodedotjs&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.12-3776ab?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688?logo=fastapi&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-24%20%E5%BC%A0%E8%A1%A8%20%2B%203%20%E8%A7%86%E5%9B%BE-4169e1?logo=postgresql&logoColor=white)

![架构图](docs/architecture.png)

> 文字版架构、数据流与设计取舍：[docs/architecture.md](docs/architecture.md)（矢量图：[architecture.svg](docs/architecture.svg)）
> SEO 现状与上线清单：[docs/SEO.md](docs/SEO.md) ｜ 接口契约：[docs/api.md](docs/api.md)
> 架构图由 `npm run architecture:update` 按文件清单生成，`pre-commit` 自动同步。

## 功能

| 路由 | 页面 | 核心能力 |
| --- | --- | --- |
| `/` | 赛事投注 | 5 种玩法池、赔率勾选、**赔率接近标注**（最低两档 ≤8% 时标 ≈，蓝框为分析偏向）、**一键串关**（赔率→λ→泊松→EV）、奖金按体彩单注限额封顶、方案截图、单场与方案两级 AI 分析（SSE）、登录后可保存投注 |
| `/match/:matchId` | 对战详情 | 交锋 / 伤停 / 近况 / 积分 / 阵容 / 射手 / 未来赛程 / 比赛地天气；PC 弹框与 H5 页面共用正文 |
| `/history` | 开奖历史 | 三种彩种走势；大乐透号码矩阵 + 逐期指标 + 下期 5+2 号码参考 |
| `/history-analysis` | 分析页面 | 频次 / 遗漏 / 马尔可夫 / 滚动回测 / 组合推荐，权重与阶数可调 |
| `/math-trend-analysis` | 数学走势 | 线性回归趋势、预测中心、波动率、大样本回测 |
| `/results` | 赛果开奖 | 按比赛日翻看比分与五个玩法的开奖结果 |
| `/odds-distribution` | 赔率分布 | 开奖记录 × 总进球赔率：不限时间统计最低 / 倒数第二低 / 第三低 / 中奖赔率分布与中奖排名 |
| `/horoscope` | 星座运势 | 12 星座 × 5 种时间维度 + 基于 IP 的天气 |
| `/login` `/auth/wechat` `/account` | 账号 | 邮箱密码 / 验证码登录，可接微信扫码；登录态 30 天 |
| `/my-bets` | 我的投注 | 保存的方案按赛果自动判中奖、算奖金；详情可导出截图或一键回填 |
| `/about` `/profile` | 演示页 | Keep-Alive（保留输入）与非缓存路由两个示例 |

设计要点：

- **Keep-Alive 路由**：页面切走后保持挂载（`display` 切换），输入与滚动位置不丢。
- **SSR + 首屏预取**：首页比赛列表与赛果开奖在服务端取好再渲染，爬虫不执行 JS 也能读到内容。
- **本地优先**：开奖历史落 IndexedDB，离线仍能翻；分析结果走服务端快照（2 KB gzip），拖权重时把权重作为 `w=` 参数交给 Python 现算（400ms 防抖），前端不保留任何算法副本。
- **登录可选**：不登录也能看全部只读功能，登录只解锁保存投注与结算。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | React 19、Next.js 16 App Router、Zustand 5、Sass、html2canvas |
| 服务端 | Node ≥ 20 原生 ESM，唯一运行时依赖 `pg`；REST + SSE |
| 分析服务 | Python 3.12 + FastAPI（Vercel Python 运行时），psycopg 连接池；与 Node 版逐字段对拍（概率差 < 5e-3） |
| 爬虫 | Node 原生 ESM；体彩走 `fetch`，阵容走 Playwright（复用系统 Chrome） |
| 数据 | PostgreSQL（生产 Prisma Postgres），24 张表 + 3 个视图 |

## 快速开始

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm run db:migrate        # 建表 + 种子

npm run dev               # API :3001 + Next :3000（/api 走 rewrite 代理）

# 要改分析逻辑时再起 Python 服务（默认 :3012），并让 Node 把分析接口转过去
npm run analysis:dev
ANALYSIS_API_BASE=http://127.0.0.1:3012 npm run api:dev
```

打开 <http://localhost:3000>。本地要看赛事数据，先让爬虫跑一轮（或连生产库）：

```bash
npm run crawl:matches     # 抓一次在售赛程与赔率
npm run crawl:history     # 抓四个彩种最新一页
```

> 改 `apps/api` 需要重启 `npm run dev`（API 无热重载）；前端改动由 Next 热更新。
> 用 `127.0.0.1` 打开时如果页面能看但数据不加载，用 `localhost:3000` —— dev 资源默认只认同源。

## 常用脚本

| 脚本 | 作用 |
| --- | --- |
| `npm run dev` | 并行启动 API 与 Next dev server |
| `npm run build` / `npm run web:start` | 生产构建 / 本地跑生产产物 |
| `npm run api:test` / `npm run crawl:test` | 服务端与爬虫单测（`node:test`） |
| `npm run analysis:dev` / `analysis:test` | 本地起 Python 分析服务（:3012）/ 跑 Python 单测与对拍 |
| `npm run analysis:fixtures` | 重新导出对拍夹具（推荐 / 开奖 / AI 提示词） |
| `npm run db:migrate` / `db:status` / `db:verify` | 迁移、状态、结构与约束自检 |
| `npm run crawl` / `crawl:daemon` | 爬虫入口 / 常驻调度（受销售时段闸门约束） |
| `npm run deploy` | 前端 + API 一起发（`deploy:local` / `deploy:api` 可单发） |
| `npm run deploy:analysis` | 发布 Python 分析服务（Vercel 项目 `ticai-analysis`） |
| `npm run check:secrets` | 扫描暂存区密钥 |
| `npm run architecture:update` | 重新生成架构图 |

完整脚本与参数见 `package.json` 与各 `README`。

## 部署

三个 Vercel 项目：

| 项目 | 内容 | 入口 |
| --- | --- | --- |
| `ticai` | 前端（Next.js SSR） | `next build` 产物；`/api/**` 由 `next.config.ts` rewrite 到 `ticai-service` |
| `ticai-service` | API（Serverless Function） | `apps/api/api/index.js` + 全路径 rewrite；分析接口反向代理到 `ticai-analysis` |
| `ticai-analysis` | Python 分析服务（FastAPI） | `apps/analysis/api/index.py`；`vercel.json` 用 `?__path=/$1` 携带原路径，入口中间件还原 |

```bash
npm run deploy           # 前端 + API
npm run deploy:local     # 只发前端（本地 next build 自检 → 上传源码 → Vercel 远端构建）
npm run deploy:api       # 只发 API
npm run deploy:analysis  # 只发 Python 分析服务（首次需先 link 项目，见 apps/analysis/README.md）
```

- 前端不上传 `.env*`、`apps/`、`db/`、`scripts/`，环境变量由 Vercel 注入；
- 分析服务需要 `DATABASE_URL` / `DATABASE_SSL` / `DEEPSEEK_API_KEY`，并且**必须关闭 Deployment Protection**；
- `DEPLOY_DRY_RUN=1` 只自检与暂存、不发布；
- `git push` 到 `main` 会自动发布前端与 API，`SKIP_DEPLOY=1 git push` 跳过。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 分层、路由、数据流、设计取舍、技术债 |
| [docs/api.md](docs/api.md) | 34 个接口的契约、SSE 协议、错误码 |
| [docs/SEO.md](docs/SEO.md) | 收录现状、meta / robots / sitemap、上线清单 |
| [apps/api/README.md](apps/api/README.md) | 服务端结构、配置、部署 |
| [apps/analysis/README.md](apps/analysis/README.md) | Python 分析服务：目录、对拍、部署与路径还原 |
| [apps/crawler/README.md](apps/crawler/README.md) | 爬虫链路、调度规则、上游实测结论 |
| [db/README.md](db/README.md) | 表结构、写入契约、保留策略 |
| [.env.example](.env.example) | 全部环境变量占位 |

## 已知限制

- 爬虫是**本机常驻进程**，机器关机就没有新数据；可用系统计划任务在 09:00 跑 `npm run crawl -- official` 兜底。
- 阵容来自 500.com（非官方），页面结构变化会抓取失败；官方名单出现后覆盖。
- 只读接口无鉴权；登录接口有频次限制、AI 接口有 IP 限流，公网暴露前建议加网关。
- 除首页外，页面数据仍是客户端拉取；`node:test` 88 个 + Python 38 个用例，但没有 ESLint / CI。

## 声明

本项目仅用于个人学习与技术实践。数据来自中国体彩、500.com 与聚合数据的公开接口，请遵守相关服务条款。
不构成任何投注建议，彩票有风险，请理性购彩，未满 18 周岁请勿购买彩票。
