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
| `matches` | 在售赛程 + 赔率，按内容 hash 去重写快照 | 60 s |
| `history` | 四个彩种各抓最新一页（100 期） | 10 min，或按 `draw_weekdays` 定点跑 |
| `history --backfill` | 从第 1 页翻到最后一页 | 一次性 |
| `details` | 伤停 + 赛果；`--full` 抓全部 7 个源 | 按需 / 低频 |
| `lineups` | 导入阵容 JSON（`--dry` 预演不落库） | 有数据时手动跑 |
| `expire` | 本地状态收敛：已开赛的比赛标为停售（不发请求） | 与 matches 同频 |
| `official` | 只刷体彩官网数据：赛程赔率 + 开奖 + 伤停赛果（不含阵容） | 每天 09:00 |
| `all` | matches + history（不含 details，它太贵） | — |

`--every=N` 进入循环模式，单轮失败不会退出（网络抖动是常态）。

### 每天 09:00 预热

`npm run crawl:daemon` 会在**北京时间每天 09:00** 跑一轮 `official`：停售收敛 → 赛程赔率 → 赛果开奖 → 开奖 → 伤停，正好赶在 11:00 开盘前把库刷成最新的。

- 只取**体彩官网**的数据，阵容（500.com）不在内；
- 这一轮**不受销售时段闸门限制**（它就是这个用途）；
- `official` 也可以手动跑：`npm run crawl -- official`；
- 改时间用 `CRAWL_DAILY_HOUR`（默认 9）。

> 不用 daemon 的话，也可以用系统计划任务在 9:00 直接跑 `npm run crawl -- official`，别和 daemon 同时开就行（会重复抓同一批数据）。

## 抓什么、不抓什么

**已实现**：在售赛程、五个玩法赔率、四彩种开奖（含奖级）、**伤停名单**、**赛果（全场 + 半场比分）**。

**没实现**：**阵容**。对战数据页有个 `getMatchPlayerV1`，看名字像球员，实际是**射手榜**，不是首发名单。体彩公开接口里没有阵容数据，这块仍然要另找源。

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

这套头写死在 `src/http.mjs` 的 `DEFAULT_HEADERS` 里。所以用 `fetch` 就够，省掉 Playwright 的 300 MB 浏览器和内存开销。

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
| `CRAWL_MATCHES_MINUTES` | 30 | 在售赛程与赔率的间隔（分钟） |

### 阵容抓取（500.com + 真实浏览器）

500.com 的阵容是 JS 渲染的，纯 HTTP 拿不到，而且 headless 会被拦，必须用**有头**浏览器。

```bash
npm i -D playwright        # 已在 devDependencies
node apps/crawler/src/index.mjs lineups-browser --run
```

流程：

1. 从本库选出「开赛前后 6 小时、还没有官方名单」的比赛；
2. 打开 500.com 当日列表页，按 **场次号**（`周四006`）建立 `场次号 → fid` 映射——体彩和 500.com 共用这套编号，**不需要模糊匹配队名**；
3. 逐场打开详情页，解析 `.box_side` 里的 `预计首发阵容` / `后备`；
4. 写 `match_lineup` + `match_lineup_player` + `player`。

几个细节：

- 页面给的是「预计首发」，所以 `confirmed=false`；官方名单出来后再抓一次会自动覆盖（查询里排除了 `confirmed=true` 的比赛）。
- 500.com 不提供阵型，`formation` 为 null。
- 复用系统安装的 Chrome（Playwright `channel: 'chrome'`），不用下载 150MB Chromium；会弹出浏览器窗口，这是反爬的代价。

只探测不写库：

```bash
node apps/crawler/src/index.mjs lineups-browser --fid=1502981   # dump 页面与网络响应
```

## 调度

**本地常驻（推荐）**：抓取在本机完成，直接写云端数据库。

```bash
npm run crawl:daemon
```

内置三条独立链路，各自频率不同、串行执行（跨境写库延迟高，并发只会互相抢连接）：

| 链路 | 频率 | 说明 |
| --- | --- | --- |
| `matches` | 每 30 分钟（`CRAWL_MATCHES_MINUTES`） | 在售赛程 + 赔率 + 自动下架，一轮约 50–60 s（跨境写库） |
| `results` | 每 30 分钟（同上，无待开奖时跳过） | 赛果开奖：官网接口按日期区间一次拿一批，回写比分与各玩法结果 |
| `lineups` | 每 60 分钟（`CRAWL_LINEUPS_MINUTES`） | 开赛前后 6 小时内的比赛，从 500.com 抓阵容 |
| `history` | 每 3 小时（`CRAWL_INTERVAL_MINUTES`） | 四彩种各 100 期，约 3 分钟 |
| `details` | 每 3 小时（`CRAWL_INTERVAL_MINUTES`） | 伤停（`--full` 时 7 个源），约 2 分钟 |

> 2026-10 起「赛果」不再逐场抓：官网赛果开奖接口
> `getUniformMatchResultV1` 支持按日期区间分页（一次 100 条），
> 一天的全部场次 1–2 个请求就够。`details` 的默认 feed 因此只剩伤停，
> 每场请求数从 2 次降到 1 次。

三条链路错开 5 秒启动、串行排队；上一轮没跑完时同一任务不会重复入队。

### 只在能投注的时候抓

非销售时段盘口不会变，抓了也是白跑，所以 `matches` / `details` / `lineups` 都过一道闸门：

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
| 单测 | 19/19（`node --test test`） |
