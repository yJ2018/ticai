# @ticai/crawler

独立爬虫进程。**与主应用完全隔离**：有自己的 `package.json`、自己的进程，不 import `src/` 或 `apps/api/`，只通过数据库交汇。

```
体彩 webapi ──▶ 本进程 ──写──▶ PostgreSQL ──读──▶ apps/api ──▶ 前端
```

## 快速开始

```bash
npm install                                   # 仓库根目录，装 pg
export DATABASE_URL=postgres://...            # 或写进根 .env

node apps/crawler/src/index.mjs matches       # 抓一次在售赛程
node apps/crawler/src/index.mjs results       # 抓最近 3 天赛果开奖
node apps/crawler/src/index.mjs results --days=30        # 回灌最近 30 天
node apps/crawler/src/index.mjs results --from=2026-09-01 --to=2026-09-30
node apps/crawler/src/index.mjs history       # 抓四个彩种最新一页
node apps/crawler/src/index.mjs history --backfill   # 逐页回灌历史
node apps/crawler/src/index.mjs history --backfill --game=qxc,dlt --delay=4500   # 只补某几个彩种并放慢
node apps/crawler/src/index.mjs all --every=60       # 循环跑
```

`--delay=<ms>` 控制每页间隔（默认 `CRAWL_DELAY_MS`，另外加 0~50% 的随机抖动）；
`--game=pl5,qxc` 只回灌指定彩种；两者配合可以把回灌压到很轻的请求节奏。

首次使用前先把库建好：`npm run db:migrate`。

## 命令

| 命令 | 作用 | 典型频率 |
| --- | --- | --- |
| `matches` | 在售赛程 + 赔率，按内容 hash 去重写快照 | 30 min |
| `results` | 赛果开奖：比分 + 五个玩法结果，回写 `match` 与 `match_result`；已开奖场次固化最后一份总进球赔率与全玩法收盘赔率（`closing_odds`） | 30 min（无待开奖比赛时跳过） |
| `history` | 四个彩种各抓最新一页（100 期） | 3 h |
| `history --backfill` | 从第 1 页翻到最后一页 | 一次性 |
| `details` | 伤停 + 积分/交锋/近况/射手（全部 7 个源）；`--injury-only` 只抓伤停 | 3 h |
| `lineups` | 导入阵容 JSON（`--dry` 预演不落库） | 有数据时手动跑 |
| `lineups-espn` | 从 ESPN 抓赛前首发（`--window` / `--limit` / `--dry`） | 20 min |
| `expire` | 本地状态收敛：已开赛的比赛标为停售（不发请求） | 与 matches 同频 |
| `official` | 只刷体彩官网数据：赛程赔率 + 赛果开奖 + 开奖 + 伤停/积分/交锋/近况（不含阵容） | 每天 09:00 |
| `all` | matches + history（不含 details，它太贵） | — |

`--every=N` 进入循环模式，单轮失败不会退出（网络抖动是常态）。

### 每天 09:00 预热

`npm run crawl:daemon` 会在**北京时间每天 09:00** 跑一轮 `official`：停售收敛 → 赛程赔率 → 赛果开奖 → 开奖 → 伤停，正好赶在 11:00 开盘前把库刷成最新的。

- 只取**体彩官网**的数据，阵容（ESPN）不在内；
- 这一轮**不受销售时段闸门限制**（它就是这个用途）；
- `official` 也可以手动跑：`npm run crawl -- official`；
- 改时间用 `CRAWL_DAILY_HOUR`（默认 9）。

> 不用 daemon 的话，也可以用系统计划任务在 9:00 直接跑 `npm run crawl -- official`，别和 daemon 同时开就行（会重复抓同一批数据）。

## 抓什么、不抓什么

**已实现**：在售赛程、五个玩法赔率、四彩种开奖（含奖级）、**伤停名单**、**赛果（全场 + 半场比分）**、**积分/交锋/近况/射手（体彩 7 源）**、**阵容**（ESPN 官方首发 + 替补 + 阵型，见下文「阵容抓取」）。

**不抓**：体彩官方阵容（体彩公开接口里没有，`getMatchPlayerV1` 实际是射手榜，不是首发名单）。

### 对战数据：7 个接口

`m.sporttery.cn/zqlszl/bssj/index.html?mid=2042119` 背后是这 7 个接口（都挂在 `webapi.sporttery.cn/gateway/uniform/football`）：

| 源 | 路径 | 落库位置 |
| --- | --- | --- |
| `injury` | `getInjurySuspensionV1.qry` | `player` + `injury`（规范化） |
| `result` | `getMatchResultV1.qry` | `match.home_score/away_score/home_half_score/away_half_score` → 自动生成 `htft` |
| `history` | `getResultHistoryV1.qry` | `match_feed`（原始 JSON） |
| `future` | `getFutureMatchesV1.qry` | `match_feed` |
| `feature` | `getMatchFeatureV1.qry` | `match_feed` |
| `tables` | `getMatchTablesV1.qry` | `match_feed` |
| `shooter` | `getMatchPlayerV1.qry` | `match_feed` |

**踩过的坑**：URL 里的 `mid` 是 **`sportteryMatchId`**（体彩官方赛事 ID），不是 `matchId`（外部数据商 ID）。用错参数，7 个接口全部返回 `{"value":{}}` 且 `success:true`——不报错，只是空。

`getMatchResultV1` 返回的 `fullCourtGoal` / `halfTimeGoal` 就是全场与半场比分，形如 `"2:5"` / `"1:2"`。它列的是"两队最近 N 场"，里面大部分是历史比赛；只有能对上本地 `match` 表的才会更新比分，对不上的自然忽略。

### 伤停怎么落库

1. 球员按 `sporttery_person_id` upsert，**不靠姓名匹配**（中文译名会变）；
2. 一人一条未愈记录，`source_ref = sporttery:<personId>`；
3. 本次名单里没出现的，视为已恢复，`ended_on` 置当天——只在本次确实拿到该队 block 时才做，避免接口局部失败导致误关闭。

`injury.injury_type` 存 `injury` / `suspension`，对应体彩的伤病与停赛标记。

## 关于"自动打开体彩"

**不需要浏览器**。实测：不带 `Referer` 时 WAF 直接返回 `HTTP 567`；补齐下面这几个头就 200：

```
referer: https://www.sporttery.cn/
origin:  https://www.sporttery.cn
user-agent: ...Chrome/131.0.0.0...
accept-language: zh-CN,zh;q=0.9
```

这套头写死在 `src/http.mjs` 的 `DEFAULT_HEADERS` 里。所以用 `fetch` 就够，省掉浏览器的 300 MB 和内存开销。

如果有一天真的 567（通常是出口 IP 被判定），错误信息会明确提示；那时再考虑换出口或加浏览器，而不是现在就背这个包袱。

## 写入规则

1. **幂等**：全部 `on conflict`，重跑不产生重复。实测连跑两次，赔率快照 `changed=0`、开奖总数不变。
2. **赔率只写变化**：先剔除 `updateDate`/`updateTime` 再算 `sha256`（这两个字段每次刷新都变，但不代表赔率变了），内容不变就不写行。
3. **下架不删除**：本轮没再出现的在售比赛，`sell_status` 改 `closed`，历史赔率还能用。
4. **每轮记账**：`crawl_run` 一行，`/api/health` 靠它算数据新鲜度。
5. **礼貌抓取**：请求之间至少间隔 `CRAWL_DELAY_MS`（默认 1200 ms）。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | — | 必填 |
| `DATABASE_SSL` | 关 | 云数据库设 `1` |
| `CRAWL_GAMES` | `350133,35,85,04` | 要抓的彩种 `gameNo` |
| `CRAWL_DELAY_MS` | 1200 | 请求间隔 |
| `CRAWL_TIMEOUT_MS` | 20000 | 单请求超时 |
| `CRAWL_RETRIES` | 2 | 5xx/429 重试次数（567 不重试） |
| `CRAWL_MAX_PAGES` | 200 | 回灌页数上限 |
| `CRAWL_INTERVAL_MINUTES` | 180 | history / details 的间隔（分钟） |
| `CRAWL_MATCHES_MINUTES` | 30 | 在售赛程、赛果与赔率的间隔（分钟） |
| `CRAWL_LINEUPS_MINUTES` | 20 | 阵容间隔（分钟） |
| `CRAWL_LINEUPS_LIMIT` | 8 | 每轮最多处理多少场阵容 |
| `CRAWL_LINEUPS_GATE` | 0 | 阵容是否也过销售时段闸门（默认不过，凌晨场次的名单在停售时段公布） |
| `CRAWL_DETAILS_FULL` | 1 | `details` 是否抓全部 7 个源（关掉只抓伤停） |
| `CRAWL_DAILY_HOUR` | 9 | 每天几点跑 `official` 预热（北京时间） |
| `BET_WINDOW_WEEKDAY` / `BET_WINDOW_WEEKEND` | `11:00-22:00` / `11:00-23:00` | 竞彩销售时段闸门 |

### 阵容抓取（ESPN 官方首发）

2026-11 起阵容改走 ESPN：`site.api.espn.com` 的 `summary.rosters` 直接给首发/替补、位置、球衣号和阵型，
纯 HTTP 就能取（赛前约 1 小时公布），不再需要 Playwright 有头浏览器。

```bash
node apps/crawler/src/index.mjs lineups-espn --window=3 --limit=15
node apps/crawler/src/index.mjs lineups-espn --dry        # 预演，写入后回滚
```

流程：

1. 从本库选出「开赛前 20 分钟到未来 2.5 小时、还没有 ESPN 官方名单」的比赛；
2. 体彩联赛名 → ESPN slug（`src/espn.mjs` 的 `ESPN_LEAGUES`，只收实测 200 的联赛）；
3. 按开赛时间 ±12 分钟对 ESPN 赛事；同一时间多场时用体彩英文缩写对 ESPN 缩写（编辑距离）消歧，对不唯一就跳过；
4. 取 `summary.rosters`，**两队都够 11 名首发**才算公布，写 `match_lineup` + `match_lineup_player` + `player`，`source='espn'`。

几个细节：

- ESPN 给的是官方名单，`confirmed=true`，阵型一并写入（500.com 时代 `formation` 恒为 null）。
- 球员按「球队 + 姓名」复用，姓名是英文（ESPN 没有中文名）；旧的中文球员记录不会被删除。
- 没有 ESPN 映射的联赛（韩国 K 联赛、日乙、日本联赛杯、巴西杯、亚冠二级）本轮直接跳过，不影响其它链路。
- ESPN 没有伤停数据（`/injuries` 恒为空），伤停继续走体彩官方 `injury` feed。

## 调度

**本地常驻（推荐）**：抓取在本机完成，直接写云端数据库。

```bash
npm run crawl:daemon
```

内置六条独立任务（`expire` 纯本地，不发请求），各自频率不同、串行执行（跨境写库延迟高，并发只会互相抢连接）：

| 链路 | 频率 | 说明 |
| --- | --- | --- |
| `matches` | 每 30 分钟（`CRAWL_MATCHES_MINUTES`） | 在售赛程 + 赔率 + 自动下架，一轮约 50–60 s（跨境写库） |
| `expire` | 每 30 分钟（同上，纯本地） | 已开赛的比赛标为停售，不发请求 |
| `results` | 每 30 分钟（同上，无待开奖时跳过） | 赛果开奖：官网接口按日期区间一次拿一批，回写比分与各玩法结果 |
| `lineups` | 每 20 分钟（`CRAWL_LINEUPS_MINUTES`） | 赛前 2.5 小时内、还没有官方名单的比赛，从 ESPN 抓首发 |
| `history` | 每 3 小时（`CRAWL_INTERVAL_MINUTES`） | 四彩种各 100 期，约 3 分钟 |
| `details` | 每 3 小时（`CRAWL_INTERVAL_MINUTES`） | 伤停 + 积分/交锋/近况/射手（7 个源），约 5 分钟 |

> 2026-10 起「赛果」不再逐场抓：官网赛果开奖接口
> `getUniformMatchResultV1` 支持按日期区间分页（一次 100 条），
> 一天的全部场次 1–2 个请求就够。`details` 的默认 feed 因此只剩伤停，
> 每场请求数从 2 次降到 1 次。

六条任务错开 5 秒启动、串行排队；上一轮没跑完时同一任务不会重复入队。

### 只在能投注的时候抓

非销售时段盘口不会变，抓了也是白跑，所以 `matches` / `details` 过一道闸门；
`lineups` 走 ESPN、不发体彩请求，默认**不过**闸门（凌晨场次的官方名单正是在停售时段公布）。

| 限制 | 规则 | 可配置 |
| --- | --- | --- |
| 销售时段 | 平日 11:00–22:00、周末 11:00–23:00（北京时间） | `BET_WINDOW_WEEKDAY` / `BET_WINDOW_WEEKEND` |
| 可投注比赛 | 阵容只抓 `sell_status='on_sale'`、未开赛、未取消的比赛 | — |
| 已停售比赛 | 开赛后不再抓阵容（`kickoff_at > now()`） | — |
| 开盘补跑 | 被闸门挡掉后会排一个一次性定时器，开盘那一刻立刻抓一次，不用等下一个周期 | — |

`history`（开奖）不受影响，照常跑。

> 体彩的列表在结算前仍会返回已开赛的比赛，所以 `matches` 写库时按开赛时间兜底：`kickoff_at <= now()` 一律记 `closed`，避免把本地停售状态改回在售。

> 权衡：凌晨场次（03:00 开赛）的**官方**阵容会在停售时段公布，默认会被闸门挡掉，只能拿到前一晚的预计阵容。
> 如果更看重阵容完整度，设 `CRAWL_LINEUPS_GATE=0`，让阵容不受销售时段限制。

> **跨零点场次**：赛程接口按「销售日」分组，凌晨 00:00–08:30 的场次归在前一天的期号里，
> 真正的比赛日写在元素的 `matchDate` 上。`kickoff_at` 必须用它拼（`resolveMatchDate`）；
> 只用 `businessDate + matchTime` 会把开赛时间整体提前 24 小时，`expire` 与 `matches` 的
> 「已开赛兜底」会在开赛前一天把这些场次判成 `closed`，前端在售列表和阵容会一起消失。

需要 `.env` 里配好 `DATABASE_URL`（云端库连接串）和 `DATABASE_SSL=1`。

Windows 开机自启：

```powershell
schtasks /create /tn ticai-crawler /tr "cmd /c cd /d D:\ticai && npm run crawl:daemon" /sc onlogon /rl highest
```

单机也可以改用 systemd timer：

```ini
# /etc/systemd/system/ticai-crawl-matches.service
[Service]
WorkingDirectory=/opt/ticai
EnvironmentFile=/opt/ticai/.env
ExecStart=/usr/bin/node apps/crawler/src/index.mjs matches
```

配一个 `OnUnitActiveSec=60s` 的 timer 即可；开奖用单独的 timer，晚 21:30 之后每 10 分钟跑一次。

回灌的耗时参考：4 个彩种 × 100 期/页，单页约 1–2 s，全量 78 页大约几分钟，中途断了直接重跑即可（幂等）。

## 已验证（2026-10-22，真实接口 + 真实库）

| 项 | 结果 |
| --- | --- |
| `matches` | 25 场在售、50 支球队、15 个联赛、25 条赔率快照，0.2 s |
| 重复抓取 | `changed=0`，快照数不变 |
| `history` | 四个彩种各 100 期，共 1985 条奖级 |
| 号码拆分 | 大乐透 `01 06 10 15 32 03 04` → 前区 5 + 后区 2；排列五保留 `0` |
| 重复抓取 | 400 期 / 1985 条奖级，总数不变 |
| `details` | 26 场 × 2 源 = 52 次请求，17.8 秒，0 失败 |
| 比分回填 | 昂热 2:5 马赛、半场 1:2 → `htft = aa`，`result_source = sporttery` |
| 伤停 | 89 名球员 / 89 条伤停，球队映射正确（AC米兰、亚特兰大等真实球员） |
| 原始订阅源 | 52 条 `match_feed`（26 场 × injury + result） |
| 单测 | 40/40（`node --test test`） |
