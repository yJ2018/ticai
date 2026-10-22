# @ticai/api

把原 BFF 里 8 个接口抽出来的独立服务端。零框架、零构建，只有 `pg` 一个运行时依赖。

```
爬虫 ──写──▶ PostgreSQL ──读──▶ 本服务 ──HTTP──▶ 前端（Vercel）
```

## 运行

```bash
# 仓库根目录
npm install                      # 首次，装 pg

# 需要数据库的两个接口要配 DATABASE_URL（根 .env 或 apps/api/.env）
node apps/api/src/index.mjs      # 或 npm run api:dev

node --test apps/api/test        # 或 npm run api:test
```

启动后会打印数据库、DeepSeek、聚合数据各自的就绪状态。

## 接口

| 路径 | 数据来源 | 说明 |
| --- | --- | --- |
| `GET /api/matches` | **数据库** | 在售赛事 + 最新赔率，输出体彩 `matchInfoList` 信封 |
| `GET /api/history` | **数据库** | 开奖分页，输出体彩 `{list,pageNo,pageSize,pages,total}` |
| `GET /api/match-detail?matchId=` | **数据库** | 对战详情：交锋/伤停/近况/未来/特征/积分/射手 7 个板块，缺失返回 null |
| `POST /api/ai-analysis` | **数据库 + DeepSeek** | 只收 `matchId` + `pool`；提示词/官方数据/天气全部服务端装配，SSE 返回 |
| `GET /api/horoscope` | 聚合数据 | 代理 + 10 min 缓存 |
| `GET /api/weather` | 聚合数据 | 代理 + 10 min 缓存 |
| `GET /api/ip` | 聚合数据 | 按连接 IP 查询 + 30 min 缓存 |
| `GET /api/venue-weather` | DeepSeek + Open-Meteo | 主队城市解析 + 天气 |
| `POST /api/ai-chat` | DeepSeek | 支持 `stream:true` → SSE |
| `GET /api/health` | 数据库 | 进程 + 库 + 各爬虫数据新鲜度；库不通返回 503 |
| `GET /healthz` | — | 纯存活探针，永远 200 |

## 与旧 BFF 的行为差异

1. **`/api/matches` 忽略 `poolType`**：库里存了全部玩法，一次返回即可。前端仍按 `poolType` 取自己那份，请求数从 5 次降到 1 次。
2. **`/api/history` 的 `gameNo` 支持两种写法**：`350133`（game_no）或 `pl5`（game_key）。
3. **金额字段双写**：同时输出 `totalSaleAmount`/`poolBalance`（上游真名）和 `lotterySaleAmount`/`poolAmount`（历史前端误用的名字）。这样不改前端也能把「销售额/奖池」显示出来。
4. **多了响应头**：`x-data-as-of`（库数据的最后更新时间）、`x-cache`、`x-request-id`。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | — | 必填，两个读库接口依赖；缺省时它们返回 503 |
| `DATABASE_SSL` | 关 | 云数据库设 `1` |
| `DATABASE_POOL_MAX` | 3 | serverless 环境别开大 |
| `API_PORT` / `API_HOST` | 3001 / 127.0.0.1 | 本地/VPS 监听地址 |
| `CORS_ORIGINS` | 空 | 逗号分隔白名单；空 = 只允许同源 |
| `TRUST_PROXY` | 1 | 前面有可信反代时读 `x-forwarded-for`；直连公网必须设 0 |
| `DEEPSEEK_*` / `JUHE_*` | — | 与旧 BFF 相同 |

## 部署

**Vercel**（推荐）：新建项目，Root Directory 指到 `apps/api`，环境变量配 `DATABASE_URL`。
`api/index.js` 是函数入口，`vercel.json` 把所有路径重写到它。SSE 受 `maxDuration: 60` 限制。

**VPS**：`node apps/api/src/index.mjs` + systemd + Caddy 反代（SSE 记得关 buffering）。

同一份 `createApp()` 在两边跑，不存在两套实现。

## 结构

```
src/
  app.mjs            路由表 / CORS / 错误映射 / requestId（纯 (req,res) 处理器）
  index.mjs          本地与 VPS 入口
  config.mjs         环境变量 → 配置对象
  lib.mjs            错误、响应、缓存、限流、上游 fetch
  db.mjs             pg 连接池（延迟加载，没装 pg 也能启动）
  reshape.mjs        数据库行 → 旧接口形状（纯函数，有单测）
  repos/             读库 SQL
  handlers/          按域拆的接口实现
  llm.mjs / venue.mjs  从 server/ 复制的模块，切流后 server/ 删除
test/
  reshape.test.mjs   9 个用例，node --test
```

## 切流路径

1. 前端加 `VITE_API_BASE`（默认空 = 同源），指向本服务；
2. 先切 `/api/matches`、`/api/history`，观察 `x-data-as-of` 是否推进；
3. 再切其余 6 个代理接口；
4. 最后删 `server/`、`api/*.js` 和 `VITE_SPORTTERY_DIRECT`。
