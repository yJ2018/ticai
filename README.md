# ticai · 体彩助手

> 中国体彩「排列五」开奖分析 + 竞彩足球赔率投注方案的 Web 应用。
>
> 前端 React 19 单页应用（静态托管），服务端拆成两个独立项目：
> **`apps/api`** 只读数据库，对外 REST + SSE；**`apps/crawler`** 在本机抓体彩（和 500.com 的阵容）写入数据库。
> 浏览器只与自有 API 通信，第三方密钥、提示词与上游访问全部留在服务端。

🔗 **在线预览**：前端 <https://ticai-eight.vercel.app> ｜ 接口 <https://ticai-service.vercel.app/healthz>

![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A520-5fa04e?logo=nodedotjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18%20%E5%BC%A0%E8%A1%A8-4169e1?logo=postgresql&logoColor=white)

![架构图](docs/architecture.png)

> 矢量版本：[architecture.svg](docs/architecture.svg) · 文字版说明：[architecture.md](docs/architecture.md)
> 架构图由 `npm run architecture:update` 按当前文件清单生成，`pre-commit` 会自动同步。

---

## 功能

| 路由 | 页面 | 能力 |
| --- | --- | --- |
| `/` | 赛事投注 | 5 种玩法池（胜平负/比分/进球数/半全场/混合过关）、赔率勾选、首屏骨架屏、串关注数与金额、最高奖金与彩票税、方案截图、**每场比赛 / 整个方案两级 AI 分析** |
| `/match/:matchId` | 对战详情 | PC 弹框 / H5 独立页面：交锋、伤停、近况、积分、**阵容**、射手、未来赛程、比赛地天气 |
| `/history` | 开奖历史 | 排列五开奖列表、号码走势、首屏骨架屏、基于本地数据的预测摘要 |
| `/history-analysis` | 分析页面 | 频次/遗漏/马尔可夫/滚动回测/组合推荐，权重与马尔可夫阶数可调 |
| `/math-trend-analysis` | 数学走势 | 线性回归趋势、预测中心、波动率、大样本回测 |
| `/horoscope` | 星座运势 | 12 星座 × 5 种时间维度 + 基于服务端 IP 定位的天气 |

设计要点：

- **Keep-Alive 路由**：页面切换后保持挂载（`display` 切换），滚动位置与输入状态不丢失。
- **重计算下沉 Worker**：预测算法在 Web Worker 中执行，主线程不卡顿，并有主线程降级路径。
- **本地优先**：开奖历史落 IndexedDB，分析类页面完全本地计算。
- **数据只读一份**：页面渲染的数据全部来自自有 API 读库，浏览器不再直连体彩。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | React 19、React Router 6、Zustand 5、Sass、html2canvas、Web Worker |
| 构建 | Vite 8 + TypeScript 6（`tsc && vite build`） |
| API | Node ≥ 20 原生 ESM，唯一依赖 `pg`；REST + SSE，CORS 白名单 |
| 爬虫 | Node 原生 ESM；体彩走 `fetch`，阵容走 Playwright（复用具系统 Chrome） |
| 数据库 | PostgreSQL（生产为 Vercel 上的 Prisma Postgres），16 张表 + 2 个视图 |
| 持久化 | IndexedDB（开奖历史）、localStorage（AI 结果缓存 3 小时） |

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env        # Windows: copy .env.example .env
#   必填：DATABASE_URL（云端库再加 DATABASE_SSL=1）
#   可选：聚合数据 / DeepSeek 密钥

# 3. 初始化数据库（第一次，或拉到新迁移时）
npm run db:migrate

# 4. 启动开发环境：API :3001 + Vite :5173（/api 走代理）
npm run dev
```

打开 <http://localhost:5173>。

> 改了 `apps/api` 的代码需要重启 `npm run dev`（API 没有热重载）；前端改动由 Vite 热更新。

本地要看到赛事数据，需要爬虫先跑一轮（或直接连生产库）：

```bash
npm run crawl:matches      # 抓一次在售赛程与赔率
npm run crawl:history      # 抓四个彩种最新一页
```

## 脚本

| 脚本 | 作用 |
| --- | --- |
| `npm run dev` | 并行启动 API 与 Vite，任一退出则联动关闭 |
| `npm run dev:api` / `npm run dev:web` | 只启动其中一个 |
| `npm run build` | `tsc` 类型检查 + 静态产物构建 |
| `npm run api:test` | API 单测（`node:test`） |
| `npm run crawl:test` | 爬虫单测 |
| `npm run db:migrate` / `db:seed` / `db:status` / `db:verify` | 迁移、种子、状态、结构与约束自检 |
| `npm run crawl` | 爬虫入口（`matches` / `history` / `details` / `lineups` / `official` / `expire`） |
| `npm run crawl:daemon` | 常驻调度器（销售时段闸门 + 每日 09:00 预热） |
| `npm run ai:check` | 直连 DeepSeek 自检密钥与模型连通性 |
| `npm run architecture:update` | 按当前文件清单重新生成架构图 |
| `npm run hooks:install` | 安装 pre-commit / pre-push hooks |
| `npm run deploy:local` | 本地构建并发布前端到 Vercel 生产 |

## 环境变量

**API**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `API_HOST` / `API_PORT` | `127.0.0.1` / `3001` | API 监听地址 |
| `CORS_ORIGINS` | `http://localhost:5173` | 允许的前端来源，逗号分隔 |
| `UPSTREAM_TIMEOUT_MS` | `8000` | 上游请求超时 |
| `AI_RATE_LIMIT_PER_MIN` | `10` | AI 接口每 IP 每分钟次数，`0` = 不限 |
| `VENUE_RATE_LIMIT_PER_MIN` | `20` | `/api/venue-weather` 每 IP 每分钟次数 |

**数据库**

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串（API 与爬虫共用） |
| `DATABASE_SSL` | 云端库设 `1`（不校验证书链） |

**前端（构建期注入）**

| 变量 | 说明 |
| --- | --- |
| `VITE_API_BASE` | API 域名，例如 `https://ticai-service.vercel.app`；留空 = 同源 |

**第三方**

| 变量 | 说明 |
| --- | --- |
| `JUHE_WEATHER_KEY` / `JUHE_HOROSCOPE_KEY` / `JUHE_IP_KEY` | 聚合数据，缺失时对应接口返回 503 |
| `DEEPSEEK_API_KEY` | 大模型密钥；**不要加 `VITE_` 前缀** |
| `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | 默认 `https://api.deepseek.com` / `deepseek-flash` |
| `DEEPSEEK_THINKING` / `DEEPSEEK_MAX_TOKENS` | 默认关闭思考；默认输出上限 1024 |

**爬虫调度**

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CRAWL_MATCHES_MINUTES` | `30` | 赛程与赔率间隔 |
| `CRAWL_LINEUPS_MINUTES` | `60` | 阵容间隔（仅赛前 6 小时窗口） |
| `CRAWL_INTERVAL_MINUTES` | `180` | 开奖与对战数据间隔 |
| `CRAWL_DAILY_HOUR` | `9` | 每天几点跑「仅官方数据」预热 |
| `BET_WINDOW_WEEKDAY` | `11:00-22:00` | 平日销售时段（北京时间） |
| `BET_WINDOW_WEEKEND` | `11:00-23:00` | 周末销售时段 |
| `CRAWL_LINEUPS_GATE` | `1` | 阵容是否也遵守销售时段 |
| `CRAWL_STATEMENT_TIMEOUT_MS` | `180000` | 单条 SQL 上限；跨境写库时批量 upsert 能超 90 秒 |

> 未配置聚合数据密钥时，赛事与开奖功能仍可正常使用，仅天气/星座接口不可用。

## 服务端接口

全部读库、不实时请求上游。完整契约（参数、响应示例、SSE 协议、错误码）见 **[docs/api.md](docs/api.md)**。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/matches` | 在售赛事 + 五个玩法最新赔率；只返回可投注的比赛 |
| GET | `/api/history` | 开奖历史分页，`pageSize ≤ 100` |
| GET | `/api/match-detail` | 对战详情七个板块 + 阵容；缺失项列在 `missing` |
| POST | `/api/ai-analysis` | 单场 AI 分析：只收 `matchId + pool`，提示词在服务端装配 |
| POST | `/api/ai-parlay` | 串关 AI 分析：只收选中的场次与选项 |
| POST | `/api/ai-chat` | 通用模型代理（遗留，前端不再调用） |
| GET | `/api/horoscope` | 聚合数据星座，缓存 10 分钟 |
| GET | `/api/weather` | 聚合数据天气，缓存 10 分钟 |
| GET | `/api/ip` | IP 归属地，未配置密钥时降级 |
| GET | `/api/venue-weather` | DeepSeek 解析主场城市 + Open-Meteo 比赛地天气 |
| GET | `/api/health` | 运行状态、数据新鲜度（`dataSources[].ageSeconds`） |

统一约定：参数白名单校验、统一错误信封 `{ success, errorMessage }`、错误码 `400 / 404 / 405 / 413 / 429 / 502 / 503 / 504`。

## 数据来源与爬虫

体彩公开接口没有阵容，阵容改用 500.com，两条链路彼此独立：

| 链路 | 数据 | 频率 |
| --- | --- | --- |
| `matches` | 在售赛程 + 五个玩法赔率 + 自动下架 | 每 30 分钟（销售时段内） |
| `history` | 四彩种开奖（含奖级） | 每 3 小时 |
| `details` | 伤停、赛果与半场比分（7 个官方接口） | 每 3 小时 |
| `lineups` | 阵容（500.com + Playwright，按场次号匹配） | 每 60 分钟，仅赛前 6 小时 |
| `expire` | 已开赛的比赛标为停售（纯本地） | 每 30 分钟 |
| `official` | 上面四类官方数据 | **每天 09:00**（开盘前预热） |

调度规则：

- **销售时段闸门**：平日 11:00–22:00、周末 11:00–23:00。非销售时段盘口不变，`matches` / `details` / `lineups` 跳过；`history` 与 `expire` 不受限。
- **开盘补跑**：被闸门跳过时按开盘时刻排一次性定时器，11:00 立刻抓一轮。
- **串行队列**：跨境写库延迟高，几条链路排队执行，同一任务不会重复入队。
- **已开赛兜底**：体彩在结算前仍会返回已开赛的比赛，写库时按 `kickoff_at` 一律记 `closed`。

体彩侧的三个实测事实：

1. **不需要浏览器**：不带 `Referer` 会被 WAF 拦（`HTTP 567`），补齐浏览器头即 200。
2. 对战数据的参数是 **`sportteryMatchId`**（不是 `matchId`，用错会静默返回空 `value`）。
3. 比分与半场比分来自 `getMatchResultV1`，`match.htft` 生成列据此自动产出。

详见 [apps/crawler/README.md](apps/crawler/README.md)。

## AI 分析

前端不拼提示词：单场只发 `matchId + pool`，串关只发选中的场次与选项。比赛信息、最新赔率、伤停、阵容、天气、系统提示词全部由 `apps/api` 从库里装配后再调模型。

- **单场**（`/api/ai-analysis`）：按当前玩法生成针对性预测，先展示「分析过程」再展示「预测结果」；桌面端浮在按钮左侧，移动端为底部抽屉。
- **串关**（`/api/ai-parlay`）：逐场判断已选选项，再评估关联风险、关键短板与整体信心；3 小时内的单场结论会作为「本地缓存分析」带入，避免重复展开。
- 两者都走 SSE（`meta` / `reasoning` / `content` / `done` / `error`），关闭浮层会 abort 上游请求。
- 单场与串关结果写入 `localStorage`，同一组选择 3 小时内直接复用。
- 提示词要求「无法确认阵容/伤情时必须写暂无可靠信息」，避免编造首发与伤病。

模型接入沿用 DeepSeek 的 [OpenAI 兼容接口](https://api-docs.deepseek.com/)，`POST /api/ai-chat` 保留给脚本与第三方调试。

> ⚠️ 不要使用 `VITE_DEEPSEEK_API_KEY` 之类的变量直连模型：`VITE_` 前缀的变量会被 Vite 打进浏览器代码。

验证密钥：

```bash
npm run ai:check
npm run ai:check 用一句话介绍竞彩足球
```

## 数据库

16 张表 + 2 个视图（`match_side` / `match_odds_latest`），按用途分四组：彩票域（`lottery_game` / `lottery_draw` / `lottery_prize_level`）、足球域（`league` / `team` / `player` / `match` / `match_odds_snapshot`）、对战源（`match_feed` / `injury` / `match_lineup` / `match_lineup_player`）、可观测性（`crawl_run` 等）。

```bash
npm run db:migrate     # 应用迁移 + 种子（advisory lock，失败即回滚）
npm run db:status      # 已应用 / 待应用
npm run db:verify      # 结构与约束自检
```

- 每个迁移文件独立事务，`schema_migration` 记录 checksum，改动历史迁移会告警；
- 保留策略在 `db/maintenance.sql`：阵容每队每场 1 条、赔率 120 天、`crawl_run` 30 天；
- 写入契约与上游字段实况见 [db/README.md](db/README.md)。

## 部署

两个 Vercel 项目：

| 项目 | 内容 | 入口 |
| --- | --- | --- |
| `ticai` | 前端静态资源 | `dist`，SPA fallback |
| `ticai-service` | API（Serverless Function） | `apps/api/api/index.js` + 全路径 rewrite |

前端通过构建期变量 `VITE_API_BASE` 指向 API。发布前端：

```bash
npm run deploy:local
```

脚本会：用 `VITE_API_BASE` 构建 → 校验 bundle 里确实包含该地址 → 在临时目录用预构建产物上传（不上传源码与 `.env`）→ 发布后清理临时目录。

API 项目单独部署（`apps/api` 为根目录）：Vercel 会按 `apps/api/package.json` 安装 `pg`，`vercel.json` 把所有路径重写到 `api/index.js`。

### 推送自动发布

hook 源文件在 `scripts/git-hooks/`，克隆后执行一次 `npm run hooks:install`：

- `pre-commit`：生成 `docs/architecture.svg/.png` 并加入提交，然后扫描暂存区密钥；
- `pre-push`：推送到 `main` 时先本地构建并发布前端，默认发布失败**不阻止**推送。

```bash
git push                    # 自动构建 + 发布前端
SKIP_DEPLOY=1 git push      # 本次跳过发布
DEPLOY_STRICT=1 git push    # 发布失败则阻止推送
```

## 密钥与本地文件

真实密钥只放在项目根目录 `.env`（已被 `.gitignore` 忽略）：

```bash
DATABASE_URL=postgres://...
DATABASE_SSL=1
DEEPSEEK_API_KEY=sk-...
JUHE_WEATHER_KEY=...
```

- `.env.example` 只保留空占位，可安全提交；
- `npm run check:secrets` 扫描暂存区，发现 `sk-`、32 位聚合密钥、GitHub/Vercel token 时阻止提交；
- `.vercelignore` 排除了 `.env`、`.vercel`、`resume/`；
- 密钥如果曾出现在提交、截图或聊天记录中，请到对应平台轮换。

## 数据与缓存

- **PostgreSQL**：唯一事实来源。API 只读、爬虫只写；列表接口带 15 秒 TTL 内存缓存，避免每次刷新都打库。
- **IndexedDB**（`ticai` 库）：`history_meta` 存同步元数据，`history_draws` 每条开奖一条；只写增量，超过 2 万条按期号裁剪；不可用时降级纯内存。
- **localStorage**：AI 分析结果缓存，3 小时 TTL。
- **前端请求**：统一超时 + `AbortController`，切换页面自动取消。

## 已知限制

- **爬虫是常驻本机进程**：机器关机/休眠就没有新数据。可用系统计划任务在 09:00 跑 `npm run crawl -- official` 兜底。
- **阵容来源非官方**：500.com 是第三方站点，页面结构变化会导致抓取失效；它只提供「预计首发」，官方名单（`confirmed=true`）出现后会覆盖。
- **只读接口无鉴权**：赛事与开奖可被任意调用；AI 接口有 IP 限流，但公网暴露前仍建议加网关。
- **跨境数据库**：单次写 100–300ms，批量抓取偏慢（25 场约 50 秒）。
- 聚合数据接口需要自行申请密钥，免费额度有限。
- 比赛地天气为 Open-Meteo 预报，开赛时段按小时对齐，存在误差；城市解析失败时 `available: false`。
- 两个分析页（`HistoryAnalysisPage`、`MathTrendAnalysisPage`）仍未拆分。
- 已有 `node:test` 单测 54 个，但没有 ESLint / Prettier / CI。
- 移动端在 430px 以下存在轻微横向溢出。

## 致谢与声明

本项目仅用于个人学习与技术实践，数据来源于中国体彩、500.com 与聚合数据的公开接口，请遵守相关服务条款。不构成任何投注建议。
