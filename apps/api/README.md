# @ticai/api

独立服务端：零框架、零构建，只有 `pg` 一个运行时依赖。提供 32 个接口路径（34 个处理方法），
其中赛事 / 开奖 / 赛果 / 详情 / 天气从数据库与上游读取，账号与投注读写数据库，AI 分析走 SSE，
投注推荐在服务端算概率与方案。

```
爬虫 ──写──▶ PostgreSQL ──读──▶ 本服务 ──HTTP──▶ 前端（Vercel）
```

## 运行

```bash
# 仓库根目录
npm install                      # 首次，装 pg

# 需要数据库的接口要配 DATABASE_URL（根 .env 或 apps/api/.env）
node apps/api/src/index.mjs      # 或 npm run api:dev

node --test apps/api/test        # 或 npm run api:test（105 个用例）
```

启动后会打印数据库、DeepSeek、聚合数据、邮件与微信各自的就绪状态。

## 接口

| 路径 | 数据来源 | 说明 |
| --- | --- | --- |
| `GET /api/matches` | **数据库** | 在售赛事 + 最新赔率，输出体彩 `matchInfoList` 信封 |
| `GET /api/history` | **数据库** | 开奖分页，输出体彩 `{list,pageNo,pageSize,pages,total}` |
| `GET /api/match-detail?matchId=` | **数据库** | 对战详情：交锋/伤停/近况/未来/特征/积分/射手 7 个板块，缺失返回 null |
| `GET /api/results?date=&days=` | **数据库** | 赛果开奖：比分 + `had/hhad/ttg/crs/hafu`，按真实开赛时间倒序 |
| `GET /api/odds-distribution` | **数据库** | 不限时间的总进球赔率分布：最低 / 倒数第二低 / 第三低 / 中奖赔率 + 中奖排名（读 `match_result.ttg_odds`，回退赔率快照） |
| `GET /api/match-signals?pool=` | **数据库** | 投注页「赔率接近」：最低两档差 ≤8% 才标，分析偏向复用推荐引擎的近况/伤停修正 |
| `POST /api/auth/code` | **数据库 + Resend** | 发邮箱验证码（注册 / 免密登录 / 绑定邮箱），带冷却与频次限制 |
| `POST /api/auth/register` `login` `logout`、`GET /api/auth/me` | **数据库** | 邮箱 + 密码 / 验证码登录（未注册邮箱自动建无密码账号）；Bearer 不透明 token |
| `POST /api/auth/password` | **数据库** | 设置 / 修改密码；没有密码或验证码登录的会话免当前密码，改完吊销其他会话 |
| `POST /api/auth/email` | **数据库 + Resend** | 给还没有邮箱的账号绑定邮箱（微信建的账号用它拿到密码登录能力） |
| `GET/DELETE /api/auth/identities`、`/api/auth/identities/:provider` | **数据库** | 登录方式列表与解绑（至少保留一种） |
| `GET /api/auth/wechat/*` | **数据库 + 微信开放平台** | 扫码 / 公众号网页授权；回调只发一次性票据，前端换正式会话 |
| `GET/POST /api/bets`、`GET /api/bets/stats`、`GET/DELETE /api/bets/:id` | **数据库** | 保存投注快照、按玩法筛选、按赛果自动结算 |
| `POST /api/ai-analysis` | **数据库 + DeepSeek** | 只收 `matchId` + `pool`；提示词/官方数据/天气全部服务端装配，SSE 返回 |
| `GET /api/recommendations?pool=&scope=` | **数据库** | 推荐：幂法去水 → 伤停/近况有界修正 → 单关/2串1/3串1 风控 → 同口径回测（前端不再算概率） |
| `POST /api/ai-parlay` | **数据库 + DeepSeek** | 只收选中的场次与选项，服务端补赔率/伤停并复用单场缓存 |

> **分析服务代理**：配置 `ANALYSIS_API_BASE` 后，`/api/recommendations`、
> `/api/analysis/lottery`（prediction / math_trend / dlt）、`/api/venue-weather`、
> `/api/ai-analysis` 与 `/api/ai-parlay`（含 SSE 流式）会转发给 Python 分析服务
> （[apps/analysis](../analysis/README.md)），响应头带 `x-analysis-via: python`；
> 分析服务不可达时自动回退本目录的内联实现（`x-analysis-via` 不出现）。两套实现接口形状完全一致，
> 删除该环境变量即可回滚。`x-analysis-source` 仍保留原含义（快照来源：crawler / api / computed-on-read）。
| `GET /api/horoscope` | 聚合数据 | 代理 + 10 min 缓存 |
| `GET /api/weather` | 聚合数据 | 代理 + 10 min 缓存 |
| `GET /api/ip` | 聚合数据 | 按连接 IP 查询 + 30 min 缓存 |
| `GET /api/venue-weather` | DeepSeek + Open-Meteo | 主队城市解析 + 天气 |
| `POST /api/ai-chat` | DeepSeek | 支持 `stream:true` → SSE（遗留，前端不再调用） |
| `GET /api/health` | 数据库 | 进程 + 库 + 各爬虫数据新鲜度；库不通返回 503 |
| `GET /healthz` | — | 纯存活探针，永远 200 |

## 与旧实现的行为差异

1. **`/api/matches` 忽略 `poolType`**：库里存了全部玩法，一次返回即可。前端仍按 `poolType` 取自己那份，请求数从 5 次降到 1 次。
2. **`/api/history` 的 `gameNo` 支持两种写法**：`350133`（game_no）或 `pl5`（game_key）。
3. **金额字段双写**：同时输出 `totalSaleAmount`/`poolBalance`（上游真名）和 `lotterySaleAmount`/`poolAmount`（历史前端误用的名字）。这样不改前端也能把「销售额/奖池」显示出来。
4. **多了响应头**：`x-data-as-of`（库数据的最后更新时间）、`x-cache`、`x-request-id`。
5. **投注金额服务端重算**：`POST /api/bets` 只信客户端传来的场次 / 选项 / 赔率快照，注数、金额、最高奖金与封顶由 `settlement.mjs` 重算。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | — | 必填，读库与账号/投注接口依赖；缺省时它们返回 503 |
| `DATABASE_SSL` | 关 | 云数据库设 `1` |
| `DATABASE_POOL_MAX` | 3 | serverless 环境别开大 |
| `DATABASE_IDLE_TIMEOUT_MS` / `DATABASE_KEEPALIVE_MS` | 30 min / 4 min | 空闲连接保留与长驻保活（`0` = 关闭保活） |
| `API_PORT` / `API_HOST` | 3001 / 127.0.0.1 | 本地/VPS 监听地址 |
| `CORS_ORIGINS` | 空 | 逗号分隔白名单；空 = 只允许同源 |
| `TRUST_PROXY` | 1 | 前面有可信反代时读 `x-forwarded-for`；直连公网必须设 0 |
| `DEEPSEEK_*` / `JUHE_*` | — | AI 与聚合数据密钥 |
| `RESEND_API_KEY` / `MAIL_FROM` | — | 邮箱验证码；缺省时验证码只写日志 |
| `AUTH_SESSION_DAYS` / `AUTH_CODE_MINUTES` | 30 / 10 | 会话与验证码有效期 |
| `AUTH_ALLOW_INSECURE` | 0 | 认证接口默认只接受 HTTPS |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` / `WECHAT_REDIRECT_URI` | — | 微信开放平台；缺省时 `enabled:false` |
| `APP_WEB_BASE` | `http://127.0.0.1:5199` | 微信回调结束后跳回的前端地址 |
| `ANALYSIS_API_BASE` | — | Python 分析服务地址（如 `https://ticai-analysis.vercel.app`）；留空 = 走本进程内联实现 |
| `ANALYSIS_TIMEOUT_MS` | 20000 | 代理到分析服务的超时 |

## 部署

**Vercel**（推荐）：新建项目，Root Directory 指到 `apps/api`，环境变量配 `DATABASE_URL`。
`api/index.js` 是函数入口，`vercel.json` 把所有路径重写到它。SSE 受 `maxDuration: 60` 限制。

**VPS**：`node apps/api/src/index.mjs` + systemd + Caddy 反代（SSE 记得关 buffering）。

同一份 `createApp()` 在两边跑，不存在两套实现。

## 结构

```
src/
  app.mjs            路由表 / CORS / 错误映射 / requestId / healthz（纯 (req,res) 处理器）
  index.mjs          本地与 VPS 入口
  config.mjs         环境变量 → 配置对象
  lib.mjs            错误、响应、缓存、限流、上游 fetch
  db.mjs             pg 连接池（延迟加载 / 空闲 30min / 启动预热；没装 pg 也能启动）
  reshape.mjs        数据库行 → 旧接口形状（纯函数，有单测）
  auth.mjs           密码 scrypt、验证码、会话 token
  session.mjs        Bearer 解析与 requireSession
  mail.mjs           Resend 发信
  wechat.mjs         微信 OAuth（state 签名、code 换 openid、ticket）
  proxy.mjs          分析接口反向代理（ANALYSIS_API_BASE → Python 分析服务，失败回退内联）
  recommend/         投注推荐：math（泊松 / Dixon-Coles / 去水）、odds、data、engine（风控）、backtest
  settlement.mjs     逐腿判定、复式注数、单注限额、奖金连乘
  llm.mjs / venue.mjs
  ai/                单场与串关提示词、比赛上下文装配
  repos/             读库 SQL（matches / lottery / results / bets）
  handlers/          按域拆的接口实现（sporttery / results / match-detail / ai / parlay / auth / wechat / bets / upstream / health）
test/                12 个测试文件、88 个用例（node --test）
```

## 远端库延迟

`/api/history` 的 SQL 本身只有 8–11ms，慢主要在远端 Prisma Postgres 的建连与往返：

- 连接池空闲保留 30 分钟（`DATABASE_IDLE_TIMEOUT_MS` 可调），本地/VPS 入口启动时预热，并每 4 分钟 `select 1` 保活（`DATABASE_KEEPALIVE_MS` 可调，0 = 关闭）；
- 开奖与奖级合并成一次查询，彩种元数据进程内缓存；超过 300ms 的 miss 会打印 `[history] ... resolve= query= reshape=` 分段时间，并在响应头带 `Server-Timing: db;dur=...`，浏览器 Network → Timing 可直接看到；
- 历史缓存仍为 60s，避免「刷新」拿到过旧数据；
- 若部署到 Vercel，冷启动仍会付一次建连成本，长期建议换池化入口或让函数与库同区域。

## 前端接入与部署

1. 默认**同源**：前端不设 `NEXT_PUBLIC_API_BASE`，本地由 `next.config.ts` 的 rewrite 转到 `127.0.0.1:3001`，生产转到 `ticai-service`；
2. 需要直连时再设置 `NEXT_PUBLIC_API_BASE=https://<API 域名>`（只能放域名，不能放密钥）；
3. 部署走仓库根 `npm run deploy:api`（上传 `apps/api` 源码，Vercel 侧构建），或 VPS 上 `node apps/api/src/index.mjs` + systemd + Caddy（SSE 记得关 buffering）；
4. 发布后探一次 `/healthz` 与 `/api/matches`，确认 `x-data-as-of` 在推进。
