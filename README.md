# ticai · 体彩助手

> 竞彩足球赔率投注 + 中国体彩开奖分析（排列5 / 七星彩 / 超级大乐透）+ 可选账号与投注记录。
>
> 前端 React 19 单页应用（静态托管 + 构建时预渲染），服务端拆成两个独立项目：
> **`apps/api`** 只读数据库，对外 REST + SSE；**`apps/crawler`** 在本机抓体彩（和 500.com 的阵容）写入数据库。
> 浏览器只与自有 API 通信（生产走同源 `/api` rewrite），第三方密钥、提示词与上游访问全部留在服务端。

🔗 **在线预览**：<https://yujun426.online> ｜ 接口健康检查 <https://ticai-service.vercel.app/healthz>

![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A520-5fa04e?logo=nodedotjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-23%20%E5%BC%A0%E8%A1%A8%20%2B%202%20%E8%A7%86%E5%9B%BE-4169e1?logo=postgresql&logoColor=white)

![架构图](docs/architecture.png)

> 矢量版本：[architecture.svg](docs/architecture.svg) · 文字版说明：[architecture.md](docs/architecture.md)
> 架构图由 `npm run architecture:update` 按当前文件清单生成，`pre-commit` 会自动同步。
>
> SEO（收录现状、已做的 meta / robots / sitemap、上线后要做的事）：[docs/SEO.md](docs/SEO.md)

---

## 功能

| 路由 | 页面 | 能力 |
| --- | --- | --- |
| `/` | 赛事投注 | 5 种玩法池（胜平负/比分/进球数/半全场/混合过关）、赔率勾选、**一键串关**（赔率→λ→泊松→EV 的可见分析流程，默认只串当天，可手动放开跨天）、首屏骨架屏、串关注数与金额、最高奖金与彩票税（按体彩单注限额封顶）、方案截图、**每场比赛 / 整个方案两级 AI 分析**、数据更新于 + 手动刷新（每 5 分钟自动刷新一次）、登录后可保存投注 |
| `/match/:matchId` | 对战详情 | PC 弹框 / H5 独立页面：交锋、伤停、近况、积分、**阵容**、射手、未来赛程、比赛地天气 |
| `/history` | 开奖历史 | 排列五 / 七星彩 / 大乐透三种开奖历史：位次彩种看号码走势（七星彩第七位单独配色）；大乐透看前后区号码矩阵，右侧附前区和值 / 跨度 / 奇偶比 / 大小比 / 三区比逐期指标，按近期频次与遗漏给出下期 5+2 号码参考和理由；平滑走势线、按彩种适配的骨架屏、基于本地数据的预测摘要 |
| `/history-analysis` | 分析页面 | 频次/遗漏/马尔可夫/滚动回测/组合推荐，权重与马尔可夫阶数可调 |
| `/math-trend-analysis` | 数学走势 | 线性回归趋势、预测中心、波动率、大样本回测 |
| `/results` | 赛果开奖 | 按比赛日翻看竞彩赛果：半场/全场比分 + 胜平负 / 让球 / 总进球 / 半全场 / 比分结果，开奖后 30 分钟内入库 |
| `/horoscope` | 星座运势 | 12 星座 × 5 种时间维度 + 基于服务端 IP 定位的天气 |
| `/login` | 登录 / 注册 | 可选登录：邮箱 + 密码，或邮箱验证码（Resend 发信）；可接微信扫码登录；登录后 30 天免登录 |
| `/auth/wechat` | 微信回调 | 一次性 ticket 换取正式会话，成功后跳回来源页 |
| `/account` | 账号 | 查看账号与登录方式，绑定 / 解绑微信；未接入微信开放平台时展示接入步骤 |
| `/my-bets` | 我的投注 | 保存过的投注方案，按玩法（胜平负/让球/总进球/比分/半全场）分类，按赛果自动判中奖并算理论奖金；首屏直接骨架屏，点任意一单打开详情弹层（可导出截图，或一键回填到投注页并打开方案弹层） |
| `/about` | 关于 | Keep-Alive 演示页（输入状态在切换路由后保留） |
| `/profile` | 个人页 | 非缓存路由演示，不在主导航中 |

设计要点：

- **Keep-Alive 路由**：页面切换后保持挂载（`display` 切换），滚动位置与输入状态不丢失。
- **重计算下沉 Worker**：预测算法在 Web Worker 中执行，主线程不卡顿，并有主线程降级路径。
- **本地优先**：开奖历史落 IndexedDB，分析类页面完全本地计算。
- **数据只读一份**：页面渲染的数据全部来自自有 API 读库，浏览器不再直连体彩。
- **登录可选**：不登录也能看赛事/开奖/分析；登录只用来保存投注单与查看中奖情况。
- **同源 API**：生产环境前端默认请求 `/api`，由 Vercel rewrite 代理到 `ticai-service`，bundle 里不写死 API 域名。
- **移动端导航折叠**：≤640px 时主导航收进汉堡菜单（两列），页头高度从 235px 降到 59px。
- **密码只经 HTTPS**：认证接口在公网明文请求下直接 403；库里只存 scrypt 哈希，日志不记请求体。
- **赛果一次入库**：官网「赛果开奖」接口一次拿一整天，写入 `match_result`，投注结算不再逐场爬取。
- **奖金按体彩规则封顶**：单注奖金单场 10 万、2/3 串 20 万、4/5 串 50 万、6 串以上 100 万，倍数按多注分别封顶；理论最高奖金和结算奖金都遵循这一规则。
- **危险操作二次确认**：删除投注、解绑微信等操作走统一 `ConfirmDialog`（异步 `onConfirm` + loading），不再用 `window.confirm`。
- **构建时预渲染**：`npm run build` 末尾用 Playwright 把公开页落成静态 HTML，提升首屏与 SEO 可抓取性。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | React 19、React Router 6、Zustand 5、Sass、html2canvas、Web Worker |
| 构建 | Vite 8 + TypeScript 6（`tsc && vite build` + Playwright 预渲染公开页） |
| API | Node ≥ 20 原生 ESM，唯一运行时依赖 `pg`；REST + SSE，CORS 白名单，可选登录（Bearer） |
| 爬虫 | Node 原生 ESM；体彩走 `fetch`，阵容走 Playwright（复用系统 Chrome） |
| 数据库 | PostgreSQL（生产为 Vercel 上的 Prisma Postgres），23 张表 + 2 个视图 |
| 持久化 | IndexedDB（开奖历史）、localStorage（登录 token、AI 结果缓存 3 小时、免责弹层偏好） |

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env        # Windows: copy .env.example .env
#   必填：DATABASE_URL（云端库再加 DATABASE_SSL=1）
#   可选：聚合数据 / DeepSeek / Resend / 微信密钥

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
| `npm run build` | `tsc` 类型检查 + 静态产物构建 + 公开页预渲染（API 不在线 / 无浏览器时自动跳过） |
| `npm run prerender` | 单独重跑预渲染（把 `dist/index.html` 和 `dist/prerender/*.html` 刷成最新数据） |
| `npm run api:test` | API 单测（`node:test`，52 个用例） |
| `npm run crawl:test` | 爬虫单测（40 个用例） |
| `npm run db:migrate` / `db:seed` / `db:status` / `db:verify` | 迁移、种子、状态、结构与约束自检 |
| `npm run crawl` | 爬虫入口（`matches` / `results` / `history` / `details` / `lineups` / `official` / `expire`） |
| `npm run crawl:daemon` | 常驻调度器（销售时段闸门 + 每日 09:00 预热） |
| `npm run ai:check` | 直连 DeepSeek 自检密钥与模型连通性 |
| `npm run check:secrets` | 扫描暂存区 / 仓库，拦截密钥泄漏 |
| `npm run architecture:update` | 按当前文件清单重新生成架构图（SVG + PNG） |
| `npm run hooks:install` | 安装 pre-commit / pre-push hooks |
| `npm run deploy` | 发布前端 + API 到 Vercel 生产 |
| `npm run deploy:local` | 只发布前端（本地构建 + 预构建产物） |
| `npm run deploy:api` | 只发布 API（上传 `apps/api` 源码，Vercel 侧构建） |

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
| `DATABASE_POOL_MAX` | API 连接池上限，默认 `3`（serverless 别开大） |
| `DATABASE_IDLE_TIMEOUT_MS` / `DATABASE_KEEPALIVE_MS` | 空闲连接保留 30 分钟；长驻入口每 4 分钟 `select 1` 保活（`0` = 关闭） |

**前端（构建期注入）**

| 变量 | 说明 |
| --- | --- |
| `VITE_API_BASE` | API 域名；**默认留空 = 同源 `/api`**，由前端项目的 Vercel rewrite 代理到 API 项目（本地由 Vite proxy 转发） |

**第三方**

| 变量 | 说明 |
| --- | --- |
| `JUHE_WEATHER_KEY` / `JUHE_HOROSCOPE_KEY` / `JUHE_IP_KEY` | 聚合数据，缺失时对应接口返回 503 |
| `DEEPSEEK_API_KEY` | 大模型密钥；**不要加 `VITE_` 前缀** |
| `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | 默认 `https://api.deepseek.com` / `deepseek-flash` |
| `DEEPSEEK_THINKING` / `DEEPSEEK_MAX_TOKENS` | 默认关闭思考；默认输出上限 1024 |

**账号 / 邮件 / 微信（可选）**

| 变量 | 说明 |
| --- | --- |
| `RESEND_API_KEY` / `MAIL_FROM` | 邮箱验证码；未配置时验证码只写服务端日志（密码登录仍可用） |
| `MAIL_DEV_ECHO` | 本地调试把验证码回给前端；**公网必须为 0** |
| `AUTH_SESSION_DAYS` / `AUTH_CODE_MINUTES` | 会话 30 天；验证码 10 分钟 |
| `AUTH_ALLOW_INSECURE` | 认证接口默认只接受 HTTPS；仅本地公网 http 调试时设 `1` |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` / `WECHAT_REDIRECT_URI` | 微信开放平台扫码登录；缺失时前端展示接入步骤，不影响邮箱登录 |
| `APP_WEB_BASE` | 微信回调结束后跳回的前端地址（如 `https://yujun426.online`） |
| `AUTH_STATE_SECRET` | OAuth state 签名密钥；不填时退回 `WECHAT_APP_SECRET` |

**爬虫调度**

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CRAWL_MATCHES_MINUTES` | `30` | 赛程与赔率间隔 |
| `CRAWL_LINEUPS_MINUTES` | `60` | 阵容间隔（仅赛前 6 小时窗口） |
| `CRAWL_INTERVAL_MINUTES` | `180` | 开奖与伤停数据间隔 |
| `CRAWL_DAILY_HOUR` | `9` | 每天几点跑「仅官方数据」预热 |
| `BET_WINDOW_WEEKDAY` | `11:00-22:00` | 平日销售时段（北京时间） |
| `BET_WINDOW_WEEKEND` | `11:00-23:00` | 周末销售时段 |
| `CRAWL_LINEUPS_GATE` | `1` | 阵容是否也遵守销售时段 |
| `CRAWL_STATEMENT_TIMEOUT_MS` | `180000` | 单条 SQL 上限；跨境写库时批量 upsert 能超 90 秒 |

> 未配置聚合数据密钥时，赛事与开奖功能仍可正常使用，仅天气/星座接口不可用。

## 服务端接口

赛事 / 开奖 / 赛果 / 详情全部读库，不实时请求体彩；账号与投注会写库；聚合数据、DeepSeek 与 Open-Meteo 属于受控代理，带缓存的接口会复用结果。完整契约（参数、响应示例、SSE 协议、错误码）见 **[docs/api.md](docs/api.md)**。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/matches` | 在售赛事 + 五个玩法最新赔率；只返回可投注的比赛，缓存 15 秒 |
| GET | `/api/history` | 开奖历史分页，`pageSize ≤ 100`，缓存 60 秒 |
| GET | `/api/results` | 赛果开奖：按比赛日区间返回比分与五个玩法结果 |
| GET | `/api/match-detail` | 对战详情七个板块 + 阵容；缺失项列在 `missing` |
| POST | `/api/ai-analysis` | 单场 AI 分析：只收 `matchId + pool`，提示词在服务端装配 |
| POST | `/api/ai-parlay` | 串关 AI 分析：只收选中的场次与选项 |
| POST | `/api/ai-chat` | 通用模型代理（遗留，前端不再调用） |
| GET | `/api/horoscope` | 聚合数据星座，缓存 10 分钟 |
| GET | `/api/weather` | 聚合数据天气，缓存 10 分钟 |
| GET | `/api/ip` | IP 归属地，缓存 30 分钟，未配置密钥时降级 |
| GET | `/api/venue-weather` | DeepSeek 解析主场城市 + Open-Meteo 比赛地天气 |
| POST | `/api/auth/code` / `register` / `login` / `logout` | 邮箱验证码 / 密码登录，Bearer 会话 |
| GET | `/api/auth/me` | 校验当前登录态 |
| GET / DELETE | `/api/auth/identities`、`/api/auth/identities/:provider` | 登录方式列表 / 解绑（至少保留一种） |
| GET / POST | `/api/auth/wechat/config`、`start`、`callback`、`session` | 微信扫码 / 网页授权与一次性票据换会话 |
| GET / POST | `/api/bets` | 我的投注：列表 / 保存（需登录，服务端重算注数与奖金） |
| GET | `/api/bets/stats` | 投注统计（总数、待开奖、中奖、投入、奖金） |
| GET / DELETE | `/api/bets/:id` | 投注详情 / 删除 |
| GET | `/api/health` / `/healthz` | 运行状态 + 数据新鲜度 / 纯存活探针 |

共 27 个接口路径（29 个处理方法）。统一约定：参数白名单校验、统一错误信封 `{ success, errorMessage }`、错误码 `400 / 401 / 403 / 404 / 405 / 413 / 429 / 502 / 503 / 504`；登录相关接口需要 `Authorization: Bearer <token>`。

## 数据来源与爬虫

体彩公开接口没有阵容，阵容改用 500.com，两条链路彼此独立：

| 链路 | 数据 | 频率 |
| --- | --- | --- |
| `matches` | 在售赛程 + 五个玩法赔率 + 自动下架 | 每 30 分钟（销售时段内） |
| `results` | 赛果开奖：比分 + `had/hhad/ttg/crs/hafu` 结果 | 每 30 分钟，没有待开奖比赛时跳过 |
| `history` | 四彩种开奖（含奖级） | 每 3 小时 |
| `details` | 伤停（`--full` 时抓全部 7 个官方接口） | 每 3 小时 |
| `lineups` | 阵容（500.com + Playwright，按场次号匹配） | 每 60 分钟，仅赛前 6 小时 |
| `expire` | 已开赛的比赛标为停售（纯本地） | 每 30 分钟 |
| `official` | 上面几类官方数据（不含阵容） | **每天 09:00**（开盘前预热） |

调度规则：

- **销售时段闸门**：平日 11:00–22:00、周末 11:00–23:00。非销售时段盘口不变，`matches` / `details` / `lineups` 跳过；`history`、`results` 与 `expire` 不受限。
- **开盘补跑**：被闸门跳过时按开盘时刻排一次性定时器，11:00 立刻抓一轮。
- **串行队列**：跨境写库延迟高，几条链路排队执行，同一任务不会重复入队。
- **已开赛兜底**：体彩在结算前仍会返回已开赛的比赛，写库时按 `kickoff_at` 一律记 `closed`。

体彩侧的几条实测事实：

1. **不需要浏览器**：不带 `Referer` 会被 WAF 拦（`HTTP 567`），补齐浏览器头即 200。
2. 对战数据的参数是 **`sportteryMatchId`**（不是 `matchId`，用错会静默返回空 `value`）。
3. 比分与半场比分来自 `getMatchResultV1`，`match.htft` 生成列据此自动产出。
4. 赛果开奖走 `getUniformMatchResultV1`，按日期区间一次拿一整批，不再逐场抓。
5. 阵容必须用**有头浏览器**：体彩没有阵容接口，500.com 的阵容是 JS 渲染且拦截 headless。

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

23 张表 + 2 个视图（`match_side` / `match_odds_latest`），按用途分六组：

| 域 | 表 |
| --- | --- |
| 彩票 | `lottery_game` / `lottery_draw` / `lottery_prize_level` |
| 足球 | `league` / `team` / `team_alias` / `player` / `match` / `match_odds_snapshot` |
| 赛果 | `match_result`（按 `sporttery_match_id` 幂等覆盖） |
| 对战源 | `match_feed` / `injury` / `match_lineup` / `match_lineup_player` / `external_ref` |
| 账号与投注 | `app_user` / `email_code` / `user_session` / `user_identity` / `auth_ticket` / `bet` / `bet_leg` |
| 可观测性 | `crawl_run` |

```bash
npm run db:migrate     # 应用迁移 + 种子（advisory lock，失败即回滚）
npm run db:status      # 已应用 / 待应用
npm run db:verify      # 结构与约束自检
```

- 迁移文件 `0001_init` → `0006_wechat_password_nullable`，每个文件独立事务，`schema_migration` 记录 checksum，改动历史迁移会告警；
- 保留策略在 `db/maintenance.sql`：阵容每队每场 1 条、赔率 120 天、`crawl_run` 30 天；
- 写入契约与上游字段实况见 [db/README.md](db/README.md)。

## 部署

两个 Vercel 项目：

| 项目 | 内容 | 入口 |
| --- | --- | --- |
| `ticai` | 前端静态资源 | `dist`，SPA fallback |
| `ticai-service` | API（Serverless Function） | `apps/api/api/index.js` + 全路径 rewrite |

前端默认用同源 `/api`（`vercel.json` 的 rewrite 转发到 `ticai-service`），不再把 `*.vercel.app` 写进 bundle；需要直连 API 时再用构建期变量 `VITE_API_BASE` 覆盖。

```bash
npm run deploy          # 前端 + API 一起发（最常用）
npm run deploy:local    # 只发前端
npm run deploy:api      # 只发 API
```

- `deploy:local`：默认同源构建（`VITE_API_BASE` 留空）→ 在临时目录用预构建产物上传（不上传源码与 `.env`）→ 发布后清理临时目录；显式设置 `VITE_API_BASE` 时仍会校验 bundle 里包含该地址。
- `deploy:api`：把 `apps/api` 的源码（`api/`、`src/`、`package.json`、`vercel.json`）铺到临时目录上传，Vercel 侧装 `pg` 并把所有路径重写到 `api/index.js`；发布后尽力探一次 `/healthz` 与 `/api/matches`（本机 DNS 解析不了 Vercel 域名时只告警，不算失败）。

两个脚本都走 `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`，不读写仓库根的 `.vercel`（该目录可能被安全软件或沙箱锁住）。

### 推送自动发布

hook 源文件在 `scripts/git-hooks/`，克隆后执行一次 `npm run hooks:install`：

- `pre-commit`：生成 `docs/architecture.svg/.png` 并加入提交，然后扫描暂存区密钥；
- `pre-push`：推送到 `main` 时依次发布前端与 API，默认某一步失败**不阻止**推送。

```bash
git push                    # 自动发布前端 + API
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
RESEND_API_KEY=re_...
WECHAT_APP_ID=wx...
WECHAT_APP_SECRET=...
```

- `.env.example` 只保留空占位，可安全提交；
- `npm run check:secrets` 扫描暂存区，发现 `sk-`、聚合密钥、Resend / 微信 / GitHub / Vercel token 时阻止提交；
- `.vercelignore` 排除了 `.env`、`.vercel`、`resume/`；
- 密钥如果曾出现在提交、截图或聊天记录中，请到对应平台轮换。

## 数据与缓存

- **PostgreSQL**：唯一事实来源。API 只读、爬虫只写；列表接口带 TTL 内存缓存（`matches` 15 秒、`results` 30 秒、`history` 60 秒），避免每次刷新都打库。
- **IndexedDB**（`ticai` 库）：`history_meta` 存同步元数据，`history_draws` 每条开奖一条；只写增量，超过 2 万条按期号裁剪；不可用时降级纯内存。
- **localStorage**：`ticai.auth` 存登录会话，AI 分析结果缓存 3 小时，`ticai.entertainment-disclaimer.hidden.v1:<path>` 记录免责弹层偏好。
- **前端请求**：统一超时 + `AbortController`，切换页面自动取消。

## 已知限制

- **爬虫是常驻本机进程**：机器关机/休眠就没有新数据。可用系统计划任务在 09:00 跑 `npm run crawl -- official` 兜底。
- **阵容来源非官方**：500.com 是第三方站点，页面结构变化会导致抓取失效；它只提供「预计首发」，官方名单（`confirmed=true`）出现后会覆盖。
- **只读接口无鉴权**：赛事、开奖与赛果可被任意调用；登录接口有频次限制，AI 接口有 IP 限流，但公网暴露前仍建议加网关。
- **跨境数据库**：单次写 100–300ms，批量抓取偏慢（25 场约 50 秒）。
- 聚合数据接口需要自行申请密钥，免费额度有限。
- 比赛地天气为 Open-Meteo 预报，开赛时段按小时对齐，存在误差；城市解析失败时 `available: false`。
- 微信登录需要企业主体、已备案域名与开放平台「网站应用」，未配置时只有邮箱登录可用。
- 预渲染是**构建时快照**，页面数据停留在构建那一刻；需要更新时重新构建或执行 `npm run prerender` 再发布。
- 两个分析页（`HistoryAnalysisPage`、`MathTrendAnalysisPage`）仍未拆分。
- 已有 `node:test` 单测 92 个（API 52 + 爬虫 40），但没有 ESLint / Prettier / CI。
- 移动端在 430px 以下存在轻微横向溢出。

## 致谢与声明

本项目仅用于个人学习与技术实践，数据来源于中国体彩、500.com 与聚合数据的公开接口，请遵守相关服务条款。不构成任何投注建议。
