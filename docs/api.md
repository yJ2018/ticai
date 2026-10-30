# ticai API 接口文档

> 版本：2026-10-30 · Node 服务端在 `apps/api/`；分析类接口（推荐 / 开奖分析 / 天气 / AI）由
> `apps/analysis/`（Python + FastAPI）实现，Node 反向代理并保留同口径回退。
> 实现细节见 [apps/api/README.md](../apps/api/README.md) 与 [apps/analysis/README.md](../apps/analysis/README.md)。

## 1. 基础信息

| 项 | 说明 |
| --- | --- |
| Base URL | 本地 `http://127.0.0.1:3001`；生产通过前端同源 `/api` 代理（`next.config.ts` rewrite → `ticai-service`），也可用 `NEXT_PUBLIC_API_BASE` 直连 |
| 分析类接口 | 由 `ticai-analysis`（Python）计算，经 Node 代理；响应头 `x-analysis-via: python` 表示这一跳走了 Python，`x-analysis-source` 仍是快照来源 |
| 认证 | 只读接口（赛事/开奖/赛果/详情/天气）**无需登录**；`/api/bets*`、`/api/auth/identities*`、`/api/auth/me`、`/api/auth/password`、`/api/auth/email` 需要 `Authorization: Bearer <token>`；AI 接口依赖服务端密钥与 IP 限流 |
| 跨域 | `CORS_ORIGINS` 白名单；留空表示只允许同源。允许的方法 `GET,POST,DELETE,OPTIONS`，允许 `authorization` 头 |
| 编码 | 请求与响应均为 `application/json; charset=utf-8`（SSE 除外） |
| 时间 | 所有时间戳为 ISO 8601 UTC；展示用北京时间由前端换算 |

### 1.1 三种响应形态

本服务历史上兼容过两代上游，所以存在两种 JSON 信封 + 一种 SSE：

**A. 体彩信封**（`/api/matches`、`/api/history`，保持与体彩 webapi 一致，前端零改动）

```json
{ "success": true, "errorCode": "0", "errorMessage": "", "value": { } }
```

**B. 统一信封**（其余全部接口）

```json
{ "success": true, "data": { } }
{ "success": false, "errorMessage": "参数 matchId 不合法" }
```

**C. SSE**（`/api/ai-analysis`、`/api/ai-parlay`、`/api/ai-chat` 且 `stream: true`）

```
event: meta
data: {"matchId":2042119,"pool":"ttg","weatherLabel":"Graz 14.5℃ 多云","promptChars":350}

event: content
data: {"delta":"【分析】"}

event: done
data: {"model":"deepseek-flash","finishReason":"stop","truncated":false,"usage":{...},"elapsedMs":8123}
```

事件类型：`meta`（`/api/ai-analysis` 与 `/api/ai-parlay`）、`reasoning`、`content`、`done`、`error`。
首个增量之前不写响应头，因此参数/限流/鉴权错误仍以普通 JSON 返回。

### 1.2 通用响应头

| 头 | 出现位置 | 说明 |
| --- | --- | --- |
| `x-request-id` | 所有响应 | 排障用，错误时也返回 |
| `x-cache` | `/api/matches`、`/api/history`、`/api/results`、`/api/odds-distribution`、`/api/match-signals`、`/api/horoscope`、`/api/weather`、`/api/ip` | `hit` / `miss` |
| `x-data-as-of` | `/api/matches` | 库中这批数据的最后抓取时间（ISO） |
| `x-match-count` | `/api/matches` | 本次返回场次数 |

### 1.3 错误码

| 状态 | 含义 |
| --- | --- |
| `400` | 参数非法（缺参、类型错、枚举外） |
| `401` | 未登录 / token 失效（`{ success:false, errorMessage:"请先登录" }`） |
| `403` | 认证接口拒绝明文 HTTP（本机/内网 Host 除外） |
| `404` | 接口不存在 / 彩种不存在 / 比赛未入库 / 越权访问他人投注 |
| `405` | 方法不允许（响应带 `allow` 头） |
| `413` | 请求体过大 |
| `429` | 触发限流（AI 类接口、登录/注册、邮箱验证码） |
| `500` | 未处理异常 |
| `502` | 上游返回异常 |
| `503` | 未配置数据库 / 未配置密钥 / 数据库不可用 |
| `504` | 上游超时 |

---

## 2. 数据接口（读库）

这三个接口的数据来自爬虫写入的 PostgreSQL，**不再实时请求体彩**。

### 2.1 `GET /api/matches`

在售赛事 + 每个玩法的最新赔率，输出体彩 `matchInfoList` 结构。

**只返回可投注的比赛**：`sell_status = 'on_sale'`。体彩列表在结算前仍会返回已开赛的比赛，爬虫写库时按开赛时间兜底记 `closed`，所以不会出现「已经踢完还挂着在售」的场次。

**查询参数**

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `poolType` | string | `mixed` | `had` / `crs` / `ttg` / `hafu` / `mixed`。**当前仅做校验，返回体始终包含全部玩法**（一次取全，省掉 5 次请求） |

**响应**（体彩信封）

```json
{
  "success": true,
  "errorCode": "0",
  "errorMessage": "",
  "value": {
    "matchInfoList": [
      {
        "businessDate": "2026-10-22",
        "subMatchList": [
          {
            "matchId": 2042119,
            "matchNumStr": "周四001",
            "leagueAllName": "欧罗巴联赛",
            "homeTeamAbbName": "格风暴",
            "awayTeamAbbName": "马赛",
            "homeTeamId": 1276,
            "awayTeamId": 182,
            "matchDate": "2026-10-23",
            "matchTime": "00:45:00",
            "had": { "h": "3.65", "d": "3.80", "a": "1.69" },
            "hhad": { "h": "1.95", "d": "3.40", "a": "3.10", "goalLine": "+1" },
            "ttg": { "s0": "16.00", "s1": "5.80" },
            "crs": { "s01s00": "9.00" },
            "hafu": { "hh": "3.10" }
          }
        ]
      }
    ]
  }
}
```

- 无赔率的场次不会出现玩法字段（前端显示 `--`）。
- `businessDate` 是**销售日**（期号所属的那一天），`matchDate` 是**真实比赛日**：凌晨 00:00–08:30 的场次两者差一天，展示时间要用 `matchDate`。
- 最多返回 500 场，按 `businessDate`、开赛时间升序。

### 2.2 `GET /api/history`

开奖历史分页，输出体彩 `{list,pageNo,pageSize,pages,total}`。

**查询参数**

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `gameNo` | string | 必填 | 彩种编号或键：`350133`/`pl5`、`35`/`pl3`、`85`/`dlt`、`04`/`qxc` |
| `pageNo` | int | 1 | 1–10000 |
| `pageSize` | int | 30 | 1–100 |

**响应**

```json
{
  "success": true,
  "errorCode": "0",
  "errorMessage": "",
  "value": {
    "list": [
      {
        "lotteryGameName": "超级大乐透",
        "lotteryDrawNum": "26120",
        "lotteryDrawTime": "2026-10-21",
        "lotteryDrawResult": "01 06 10 15 32 03 04",
        "totalSaleAmount": "314954142",
        "poolBalance": "824436634.68",
        "lotterySaleAmount": "314954142",
        "poolAmount": "824436634.68",
        "prizeLevelList": [
          { "prizeLevel": "一等奖", "stakeCount": "3", "prizeAmount": "10000000", "totalPrizeamount": "30000000", "sort": 101 }
        ]
      }
    ],
    "pageNo": 1,
    "pageSize": 30,
    "total": 2938,
    "pages": 98
  }
}
```

> **为什么金额有两套字段名**：体彩真实字段是 `totalSaleAmount` / `poolBalance`，但旧前端读的是 `lotterySaleAmount` / `poolAmount`。这里同时输出，既修好旧页面的「销售额/奖池」显示，又不影响后续按正确字段名开发。

### 2.2.0 `GET /api/history/bulk`

全量开奖的**紧凑格式**，一次请求拿回所有期号与号码。

2026-10-29 起前端已不再需要它：分析页的自定义权重改为 `GET /api/analysis/lottery?...&w=34-20-22-14-10`
由服务端重算并落快照。接口保留给脚本与调试。

**查询参数**

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `gameNo`（或 `game`） | string | 必填 | `350133`/`pl5`、`35`/`pl3`、`85`/`dlt`、`04`/`qxc` |

**响应**

```json
{
  "success": true,
  "errorCode": "0",
  "errorMessage": "",
  "value": {
    "gameNo": "350133",
    "gameKey": "pl5",
    "gameName": "排列5",
    "total": 7761,
    "draws": [["26286", "2 1 8 1 9"], ["26285", "6 1 3 0 0"]]
  }
}
```

- 体积：7761 期约 167 KB 明文 / 45 KB gzip（对比逐页 `/api/history` 的 1805 KB / 184 KB）；
- 缓存：进程内 10 分钟；响应头 `cache-control: public, max-age=300, s-maxage=600`；
- 限流：30 次/分钟/IP（响应头带 `x-draw-count`）。

### 2.2.1 `GET /api/analysis/lottery`

> 实现位置：`kind=prediction` / `kind=math_trend` 由 Python 分析服务计算并代理返回（响应头
> `x-analysis-via: python`）；`kind=dlt` 与未配置 `ANALYSIS_API_BASE` 时仍由 Node 计算。
> 两种情况的 payload 与 `x-analysis-*` 响应头完全一致（对拍见 `npm run analysis:test`）。

开奖分析快照（频次/遗漏/马尔可夫/滚动回测、数学走势、大乐透 5+2 推演）。
分析用**全量**开奖（排列五 7760 期），在爬虫抓到新开奖后就地算一次并落库
（`lottery_analysis_snapshot`），本接口只读最新一条快照。

**查询参数**

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `game` | string | `pl5` | `pl5` / `pl3` / `qxc` / `dlt`，或体彩 `gameNo`（`350133` / `35` / `04` / `85`） |
| `kind` | string | 位置型 `prediction`、大乐透 `dlt` | `prediction` / `math_trend` / `dlt` |
| `order` | int | 由 `config_key` 默认 | 仅 `prediction` 生效：马尔可夫阶数 1–5（开奖时已预算好 5 档） |
| `w` | string | 空 | 仅 `prediction` 生效：自定义权重百分比，5 项用 `-` 连接，如 `34-20-22-14-10`（近期频次/长期频次/遗漏/单步转移/双步转移）。参数会进 `config_key`（`markov=3;w=34-20-22-14-10`），同一组合重复请求直接命中快照 |

**响应**

```json
{
  "success": true,
  "data": {
    "game": { "gameKey": "pl5", "gameNo": "350133", "name": "排列5", "positional": true, "mainCount": 5 },
    "kind": "prediction",
    "configKey": "markov=2",
    "sample": {
      "throughIssue": "26285",
      "throughIssueSeq": 26285,
      "throughDrawDate": "2026-10-26",
      "fromIssue": "04001",
      "fromDrawDate": "2004-11-14",
      "drawCount": 7760
    },
    "engine": { "version": "snapshot-1", "digest": "133b593c984e", "runtime": "node v20.19.0" },
    "analysis": { "sampleSize": 7760, "positions": ["…"], "combinations": ["…"], "markov": {}, "statistics": {} },
    "computedAt": "2026-10-27T13:39:12.637Z",
    "source": "crawler",
    "durationMs": 1428,
    "triggered": false,
    "stale": false,
    "latestDraw": { "issue": "26285", "issueSeq": 26285, "drawDate": "2026-10-26" }
  }
}
```

`analysis` 与前端 `domain/analysisTypes.ts` 中的类型同构，可直接渲染；算法唯一实现在
`apps/analysis/app/analysis/`（Python），Node 侧 `apps/api/src/analysis/` 为同口径回退。

**溯源语义**

| 字段 | 含义 |
| --- | --- |
| `sample.throughIssue` / `throughDrawDate` | 这条分析基于哪一期、哪一天的开奖 |
| `sample.fromIssue` / `fromDrawDate` / `drawCount` | 样本起点与真正吃进去的期数（数学走势 240、大乐透 300） |
| `stale` | 库里最后一期开奖是否已领先这条快照（`true` 说明分析落后一期） |
| `triggered` | `true` 表示快照缺失、这次请求现场算了一次并落库 |

**响应头**：`x-analysis-through-issue` / `-through-date` / `-draw-count` / `-computed-at` / `-stale` / `-source`，以及 `server-timing`。

**缓存**：同一期快照不变 → `public, max-age=300, s-maxage=900, stale-while-revalidate=120`；落后于最新开奖时降到 `max-age=30, s-maxage=60`。

**错误**：彩种未知 `404`；样本不足（大乐透 < 30 期）`404`（提示执行 `npm run analyze:snapshot`）。

### 2.2.2 `GET /api/analysis/lottery/snapshots`

巡检用：每个彩种每种分析的最新快照，以及是否落后于最后一期开奖。

**查询参数**：`game`（可选，按彩种过滤）。

```json
{
  "success": true,
  "data": {
    "games": [
      {
        "gameNo": "350133",
        "gameKey": "pl5",
        "gameName": "排列5",
        "latestIssue": "26285",
        "latestDrawDate": "2026-10-26",
        "items": [
          {
            "kind": "prediction",
            "configKey": "markov=2",
            "throughIssue": "26285",
            "throughDrawDate": "2026-10-26",
            "drawCount": 7760,
            "source": "crawler",
            "durationMs": 1428,
            "computedAt": "2026-10-27T13:39:12.637Z",
            "stale": false
          }
        ]
      }
    ]
  }
}
```

### 2.3 `GET /api/match-detail`

单场对战详情，对应 `m.sporttery.cn/zqlszl/bssj` 页面的 7 个板块。

**查询参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `matchId` | int | 是 | 体彩 `sportteryMatchId`，4–12 位数字 |

**响应**

```json
{
  "success": true,
  "data": {
    "matchId": 2042155,
    "league": "澳大利亚超级联赛",
    "kickoffAt": "2026-10-23T09:00:00.000Z",
    "status": "scheduled",
    "sellStatus": "on_sale",
    "home": { "name": "布里斯班", "score": null, "halfScore": null },
    "away": { "name": "珀斯", "score": null, "halfScore": null },
    "htft": null,
    "resultSource": null,
    "feeds": {
      "history": { "matchList": [], "statistics": {} },
      "injury": { "home": { }, "away": { } },
      "result": { "home": { "matchList": [] }, "away": { } },
      "future": { },
      "feature": { },
      "tables": { "tables": [] },
      "shooter": { "home": { "playerList": [] }, "away": { } }
    },
    "fetchedAt": { "history": "2026-10-22T07:00:00.000Z" },
    "lineup": {
      "home": {
        "teamName": "格风暴",
        "formation": "4-2-3-1",
        "coach": null,
        "confirmed": true,
        "source": "manual",
        "capturedAt": "2026-10-22T17:47:56.090Z",
        "starters": [{ "name": "迪格雷戈里奥", "number": 29, "position": "GK", "starter": true }],
        "substitutes": []
      },
      "away": null
    },
    "missing": ["shooter.home"]
  }
}
```

**约定：没有的信息就空着**

- 未抓到的板块返回 `null`（不是 404、不是空对象占位）；
- 抓到了但分组为空，保留空数组（如 `shooter.home.playerList: []`）；
- `missing` 明确列出缺失项，前端据此显示「暂无数据」占位；
- `feeds` 内部是**上游原始结构**，字段随体彩变化，前端读取时需容错。

未开赛时 `score` / `halfScore` / `htft` 均为 `null`；结束后由爬虫回填，`htft` 由数据库生成列计算（`h/d/a × h/d/a`）。

---

### 2.4 `GET /api/results`

赛果开奖。数据由本地爬虫 `npm run crawl -- results` 从体彩官网赛果开奖接口
（`getUniformMatchResultV1`）写入 `match_result` 表，一次请求拿一整天，替代过去「逐场抓近期赛果」。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `date` | `YYYY-MM-DD` | 今天（北京时间） | 结束日期；非法值回退到今天 |
| `days` | 1–30 | 3 | 从 `date` 往前数几天（含当天） |
| `limit` | 1–500 | 200 | 最多返回条数 |

按**真实开赛时间**（`match.kickoff_at`，关联不到时退回销售日）筛选与升序排列，
所以「凌晨场次」不会因为销售日不同被分到前一天。

```json
{
  "success": true,
  "data": {
    "from": "2026-10-23",
    "to": "2026-10-25",
    "updatedAt": "2026-10-25T14:00:00.000Z",
    "count": 52,
    "items": [
      {
        "matchId": 2042217,
        "matchNo": "周日005",
        "matchDate": "2026-10-24",
        "leagueName": "荷兰甲级联赛",
        "homeName": "福图纳锡塔德",
        "awayName": "SBV精英",
        "homeScore": 1,
        "awayScore": 0,
        "homeHalfScore": 0,
        "awayHalfScore": 0,
        "goalLine": -1,
        "had": "h",
        "hhad": "d",
        "ttg": 1,
        "crs": "s01s00",
        "hafu": "dh",
        "settled": true,
        "status": "2",
        "poolStatus": "Payout"
      }
    ]
  }
}
```

字段口径：

- `had` / `hhad`：`h` `d` `a`，**主队视角**；`hhad` 已经加过 `goalLine`。
- `ttg`：总进球，0–7，`7` 表示 7 球及以上。
- `crs`：比分玩法的选项 key，与前端 `optionKey` 完全一致（`s02s01`、`s1sh` 等）。
- `hafu`：半全场，`hh` `hd` … `aa`。
- `settled=false` 时比分与全部结果字段都是 `null`，表示还没开奖。

---

### 2.4.1 `GET /api/odds-distribution`

开奖记录 × 赛前总进球赔率。**不限时间、无日期参数**：库里所有「已开奖 + 赛前有总进球赔率」
的场次都会进入统计，聚合成四条分布（最低赔率 / 倒数第二低 / 第三低 / 中奖赔率），
并给出中奖赔率在 8 个总进球选项里的排名分布。

**赔率来源**

1. 优先读 `match_result.ttg_odds`：赛果入库时把该场最后一份 TTG 赔率固化下来
   （迁移 `0011_match_result_ttg_odds`），因此 `match_odds_snapshot` 的 120 天保留期不会让历史分布掉数据；
2. 迁移前 / 爬虫还没固化的行，回退到当前保留期内该场最后一份 `match_odds_snapshot`。

**口径**

- 每场取 `s0..s7` 八个选项（`s7` = 7+），按赔率升序；
- 中奖排名 = 严格更低的选项数 + 1，赔率并列时共享排名（两个选项同为最低，押中任一都记最低）；
- 缺一个选项或赔率 ≤ 1 的场次整场跳过，避免半套赔率污染分布；
- `sample.coverage` = 有赔率场次 ÷ 库里有总进球赛果的场次，用来说明「老场次为什么没进来」。

```json
{
  "success": true,
  "data": {
    "sample": {
      "matches": 117,
      "settledResults": 231,
      "coverage": 0.5065,
      "skipped": 0,
      "from": "2026-10-23",
      "to": "2026-10-30",
      "updatedAt": "2026-10-30T02:14:02.246Z"
    },
    "bins": [
      { "from": 3, "to": 3.5, "label": "3–3.5", "lowest": 81, "second": 18, "third": 0, "winning": 27 }
    ],
    "series": [
      { "key": "lowest", "label": "最低赔率", "average": 3.39, "median": 3.4, "min": 2.7, "max": 4.3 }
    ],
    "ranks": [
      { "rank": 1, "label": "最低", "count": 34, "rate": 0.2906 }
    ],
    "highlights": {
      "lowestHits": 34,
      "lowestHitRate": 0.2906,
      "top3Hits": 74,
      "top3HitRate": 0.6325,
      "averageLowest": 3.39,
      "averageWinning": 6.27,
      "averageRatio": 1.87
    },
    "recent": [
      {
        "matchId": 2042322,
        "matchDate": "2026-10-30",
        "leagueName": "意大利甲级联赛",
        "homeName": "佛罗伦萨",
        "awayName": "亚特兰大",
        "score": "2:2",
        "ttg": 4,
        "ttgLabel": "4",
        "lowest": 3.25,
        "second": 4.2,
        "third": 4.4,
        "winning": 4.2,
        "rank": 2,
        "rankLabel": "第二低"
      }
    ]
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `bins` | 固定区间（`<2.5` … `30+`），每条含四个系列在区间内的场次；最后一档 `to=null` |
| `series` | 四个系列的平均 / 中位 / 最小 / 最大赔率；无样本时为 `null` |
| `ranks` | 中奖赔率排名 1–8（最低 → 最高）的场次与占比，`rate` 为 0–1 |
| `highlights` | 最低命中、前三低命中、平均最低 / 中奖与平均倍数 |
| `recent` | 最近 15 场逐场明细，含比分、总进球与中奖排名 |

缓存：单实例 5 分钟；响应头 `x-ttg-samples` 为进入统计的场次数。

---

### 2.4.2 `GET /api/match-signals`

投注页「赔率接近」标注。与 `/api/recommendations` 共用推荐引擎（市场去水 → 近况 / 伤停有界修正），
但不生成方案、不跑回测；**不限当天**，首页展示的全部在售比赛都会计算。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `pool` | `mixed` | `had`（含 had + hhad）/ `hhad` / `ttg` / `mixed`；非法值回退 `mixed` |

**标注口径**

- 同一玩法内按赔率升序，只比较**最低两档**（总进球尾部 6/7 球虽然经常只差 0.1，但对走势没有意义）；
- 相对差 `(第二低 − 最低) / 最低 ≤ 8%` 才返回信号；
- `preferred` 由推荐引擎的 `blendP`（市场概率 + 双方近期战绩 + 伤停修正）决定，不是「谁赔率低选谁」；
- 近期样本 ≥3/3 时文案写「模型偏向」，否则降级为「分析略偏」；
- 比分 / 半全场没有概率模型，不返回信号。

```json
{
  "success": true,
  "data": {
    "generatedAt": "2026-10-30T09:50:00.000Z",
    "scope": "all",
    "pool": "ttg",
    "poolLabel": "总进球",
    "signals": [
      {
        "matchId": 2042359,
        "matchNo": "周五005",
        "teams": "博德闪耀 vs 维京",
        "pool": "ttg",
        "poolLabel": "总进球",
        "gap": 0.0513,
        "note": "3球 / 4球 赔率接近（差 5.1%）；期望总进球 3.9（市场 3.9），分析略偏 3球",
        "options": [
          { "optionKey": "s3", "optionLabel": "3球", "odd": 3.9, "marketP": 0.2144, "modelP": 0.2064, "blendP": 0.2141, "preferred": true },
          { "optionKey": "s4", "optionLabel": "4球", "odd": 4.1, "marketP": 0.2026, "modelP": 0.1941, "blendP": 0.2022, "preferred": false }
        ],
        "sample": { "homeMatches": 0, "awayMatches": 1 },
        "goalExpectation": { "expectedTotal": 3.92, "marketTotal": 3.92, "homeMatches": 0, "awayMatches": 0 }
      }
    ]
  }
}
```

`pool=had` 时同一场可能同时返回 `had` 与 `hhad` 两条信号；前端按 `matchId:pool` 匹配到对应选项行。
缓存：单实例 60 秒；响应头 `x-cache`。

---

### 2.5 `GET /api/recommendations`

> 实现位置：Node 配置了 `ANALYSIS_API_BASE` 时由 Python 分析服务（`apps/analysis`）计算并代理返回（响应头
> `x-analysis-via: python`）；未配置或分析服务不可达时回退 Node 内联实现。两种情况的响应完全一致。

投注推荐，**全部在服务端算**：赔率幂法去水 → 伤停 / 近况有界修正 → 进球数据（主客场进球、对手失球、
联赛节奏）修正期望总进球 → 串关风控 → 同口径回测摘要。
前端不算任何概率（旧实现是浏览器里用同一份赔率反推 λ 再和市场比大小，等于自己跟自己打，
必然挑出 22.00 这类冷门并串成 8 串 1）。总进球选项按修正后的分布取概率最高的一个，**不是直接取最低赔率**。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `pool` | `mixed` | `had`（含让球 `hhad`）/ `hhad` / `ttg` / `mixed`；`crs`、`hafu` 返回空方案 + 说明 |
| `scope` | `today` | `today` 只算今天这个销售日；`all` 放开跨天 |

```json
{
  "success": true,
  "data": {
    "generatedAt": "2026-10-29T06:17:07.522Z",
    "scope": "today",
    "pool": "had",
    "poolLabel": "胜平负 + 让球",
    "coverage": {
      "onSale": 19, "inScope": 7, "withOdds": 7, "withInjury": 7, "withHistory": 3,
      "historyMatches": 111, "today": "2026-10-29"
    },
    "filtered": { "noOdds": 0, "noMarket": 0, "noCandidate": 0, "probTooLow": 0, "oddsOutOfBand": 0, "invalidPool": false },
    "plans": [
      {
        "id": "safe",
        "label": "稳健 2串1",
        "risk": "低",
        "legs": [
          {
            "matchId": 2042320,
            "matchNo": "周四004",
            "league": "瑞典超级联赛",
            "teams": "哈马比 vs 天狼星",
            "pool": "had",
            "poolLabel": "胜平负",
            "optionKey": "h",
            "optionLabel": "胜",
            "odd": 1.37,
            "marketP": 0.6903,
            "modelP": 0.6732,
            "blendP": 0.6896,
            "edge": -0.0552,
            "weight": 0.04,
            "confidence": "high",
            "goalExpectation": {
              "expectedTotal": 2.98,
              "marketTotal": 2.99,
              "homeAttack": 1.0,
              "homeDefense": 2.0,
              "awayAttack": 2.0,
              "awayDefense": 2.0,
              "homeMatches": 1,
              "awayMatches": 1,
              "leagueAverage": null,
              "leagueMatches": 0
            },
            "reasons": [
              "本库没有这队的近期战绩，概率只按市场与伤停估",
              "主队伤停 1 人（A. Boudri），λ 下调 3%",
              "市场 69.0% → 模型 67.3% → 融合 69.0%（-5.5 个百分点）"
            ],
            "sample": { "homeMatches": 0, "awayMatches": 0, "injuriesHome": 1, "injuriesAway": 0 }
          }
        ],
        "totalOdd": 1.92,
        "hitProb": 0.4645,
        "expectedReturn": 0.891,
        "note": "2 场串关，融合命中率 46.5%。融合概率下的期望回报 0.89×（庄家抽水仍在），只作概率参考。"
      }
    ],
    "candidates": [],
    "notes": [],
    "backtest": {
      "window": { "from": "2026-10-22", "to": "2026-10-28", "matches": 109 },
      "singles": { "n": 85, "hits": 41, "hitRate": 0.4824, "roi": -0.2306, "avgOdd": 1.634 },
      "doubles": { "n": 42, "hits": 9, "hitRate": 0.2143, "roi": -0.4547, "avgOdd": 2.694 },
      "longshot": { "n": 62, "hits": 13, "hitRate": 0.2097, "roi": 0.0644, "avgOdd": 6.092 },
      "bands": [{ "label": "1.25–1.60", "n": 41, "hits": 23, "hitRate": 0.561, "roi": -0.2407, "avgOdd": 1.393 }],
      "note": "回测只用开赛前最后一次赔率快照，按「市场概率最高 + 赔率 1.25–2.15」选场；不含任何赛后信息。样本只有几天，波动很大…"
    }
  }
}
```

门槛与风控（写死在 Python 实现 [apps/analysis/app/recommend/engine.py](../apps/analysis/app/recommend/engine.py)，
Node 回退 [engine.mjs](../apps/api/src/recommend/engine.mjs) 与之对拍，改这里要同步）：

> `goalExpectation` 是每条候选/腿的进球数据快照：`homeAttack` / `homeDefense` 取主队主场分项、
> `awayAttack` / `awayDefense` 取客队客场分项（无分项时回落到整体场均，`null` 表示完全没有样本）；
> `expectedTotal` 是修正后的期望总进球，`marketTotal` 是拟合 λ 的市场口径；`leagueAverage` 只在
> 两队样本都不足、且同联赛有 ≥8 场已结束比赛时才有值。理由文本会说明「数据期望 / 联赛节奏 / 样本不足」。

| 方案 | 场次 | 单腿赔率 | 单腿融合概率 | 总赔率上限 | 命中率下限 |
| --- | --- | --- | --- | --- | --- |
| 单关首选 | 1 | 1.20–2.15 | ≥50% | — | — |
| 单关（低概率玩法，如总进球） | 1 | 1.20–4.50 | ≥20% | — | — |
| 稳健 2串1 | 2 | 1.25–2.15 | ≥52% | 4.2 | 26% |
| 进取 3串1 | 3 | 1.40–3.30 | ≥44% | 8.0 | 15% |

- 达不到门槛时 `plans` 是空数组，`notes` 会说明原因（例如「今天没有达到门槛的方案」）。
- `candidates` 给出每场被选中的选项与未入选原因，`filtered` 是聚合计数。
- 结果按 `pool + scope + 北京日期` 缓存 60 秒；回测缓存 10 分钟。

---

## 3. 登录与投注记录

登录是**可选**能力：不登录也能看赛事 / 开奖 / 分析，登录后才能保存投注单并自动判中奖。

### 3.1 认证方式

- 登录成功后拿到 `token`（30 天有效），后续请求带 `Authorization: Bearer <token>`。
- 服务端只存 token 的 sha256，退出登录即吊销。
- 需要登录的接口在未登录 / token 失效时返回 `401`：

```json
{ "success": false, "errorMessage": "请先登录" }
```

#### 密码怎么传、怎么存

浏览器提交的是**明文密码**（HTTPS 的加密在传输层，不在应用层）——这是所有密码登录的通用做法，
不存在「前端可逆加密」能真正提升安全性的方案（密钥也在前端）。真正决定安全的是下面四条：

| 环节 | 做法 |
| --- | --- |
| 传输 | 认证接口强制 HTTPS：请求既不是 TLS、Host 也不是本机/内网地址时返回 `403`（`AUTH_ALLOW_INSECURE=1` 可临时放行，仅调试用） |
| 存储 | `scrypt(password, 随机 16 字节盐, 64)`，库里只存 `scrypt$<salt>$<hash>`，无法反推 |
| 日志 | 请求日志只记 `method / path / status / 耗时`，**从不记录请求体**；响应也不回显密码 |
| 防爆破 | 同 IP 15 次/分、同邮箱 8 次/分（注册 10 次/小时/IP，改密同样受限）；未知邮箱也会跑一次 scrypt，响应时间不泄露邮箱是否存在 |
| 改密 | 只有「没有密码的账号」或「验证码登录建立的会话」可以免当前密码设置；改完吊销该账号其他设备的会话 |

> 本地用 `http://127.0.0.1:5199` 调试时，密码在回环网卡上是明文——只有你自己这台机器能看到。
> 用 `next dev --hostname 0.0.0.0` 暴露到局域网时请确保信任同网段设备，或改用 HTTPS 隧道（如 cloudflared）。

### 3.2 `POST /api/auth/code`

发邮箱验证码。

```json
{ "email": "me@example.com", "purpose": "register" }
```

`purpose`：`register`（注册验证）、`login`（免密登录，**邮箱未注册时会自动建号**）或 `bind`（给当前账号绑定新邮箱，需要登录）。响应：

```json
{ "success": true, "data": { "sent": true, "delivered": true, "expiresInSeconds": 600 } }
```

- 未配置 `RESEND_API_KEY` 时 `delivered=false`，验证码只写服务端日志；
  本地 `MAIL_DEV_ECHO=1` 会额外返回 `devCode`（**线上必须关闭**）。
- 限流：同邮箱 60 秒冷却、每小时 6 次；同 IP 每小时 20 次，超出返回 `429`。
- `purpose=register` 时邮箱已注册返回 `409`；`purpose=bind` 时账号已有邮箱、或邮箱已被别的账号占用也返回 `409`。

### 3.3 `POST /api/auth/register`

```json
{ "email": "me@example.com", "password": "至少8位", "code": "123456" }
```

成功返回会话：

```json
{
  "success": true,
  "data": {
    "token": "…",
    "expiresAt": "2026-11-24T14:01:38.537Z",
    "expiresInDays": 30,
    "user": {
      "id": "1",
      "email": "me@example.com",
      "hasPassword": true,
      "createdAt": "2026-10-25T14:01:36.311Z"
    }
  }
}
```

### 3.4 `POST /api/auth/login`

两种形态，二选一：

```json
{ "email": "me@example.com", "password": "……" }
```

```json
{ "email": "me@example.com", "code": "123456" }
```

- **验证码登录不要求邮箱已注册**：验证码通过就证明邮箱归属，没注册过的邮箱会当场建一个「无密码」账号，
  返回的 `user.hasPassword` 是 `false`，前端据此把用户送去账号页设置密码（`POST /api/auth/password`）。
- 没设置密码的账号用密码登录返回 `401 这个账号还没有设置密码，请用验证码登录后设置`；
  密码错误返回 `401 邮箱或密码不正确`；验证码错误/过期/超次返回 `400` / `429`。
- 会话会记下建立方式（`user_session.verified_by`：`password` / `code` / `wechat`），它决定改密码时要不要当前密码。

### 3.5 `POST /api/auth/password`

设置 / 修改密码，需要登录。设置成功后这个账号就能用「邮箱 + 密码」登录。

```json
{ "password": "至少8位", "currentPassword": "旧密码（可选）" }
```

要不要当前密码，由服务端按「账号有没有密码 + 这枚会话怎么来的」判断：

| 账号状态 | 会话来源 | 要求 |
| --- | --- | --- |
| 还没有密码（验证码登录自动建的号 / 微信建的号绑了邮箱） | 任意有效会话 | 只传 `password` |
| 已有密码 | 验证码登录建立的会话（`verified_by=code`） | 只传 `password`，直接覆盖 —— 这就是「忘记密码」的自助路径 |
| 已有密码 | 密码登录 / 微信登录 | 必须传 `currentPassword`，或传一条 `code`（`purpose=login`） |

```json
{
  "success": true,
  "data": {
    "ok": true,
    "revokedSessions": 2,
    "user": { "id": "1", "email": "me@example.com", "hasPassword": true }
  }
}
```

- 改密码会吊销该账号**其他设备**的会话，只保留当前这枚（数量在 `revokedSessions`）。
- 账号没有邮箱时返回 `400 请先绑定邮箱，才能用密码登录`：密码登录的唯一标识是邮箱。
- 密码规则与注册一致（8–72 位），同样受 IP / 邮箱维度限流；错误返回 `401 当前密码不正确`。

### 3.6 `POST /api/auth/email`

给还没有邮箱的账号绑定邮箱（微信首次登录建的账号走这条）。需要登录；验证码用 `purpose=bind` 发到**新邮箱**。

```json
{ "email": "me@example.com", "code": "123456" }
```

成功返回最新用户（`user.email` 已填上，`hasPassword` 仍为 `false`），接着调 `/api/auth/password` 就能设置密码。
已经绑定过邮箱、邮箱属于别的账号都返回 `409`；验证码错误 / 过期返回 `400`。

### 3.7 `POST /api/auth/logout`、`GET /api/auth/me`

- `logout`：吊销当前 token，返回 `{ "ok": true }`。
- `me`：返回当前登录用户（含 `hasPassword`），用于刷新页面后校验本地 token。

### 3.8 `GET /api/bets`

「我的投注」列表，需要登录。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `limit` | 30 | 1–100 |
| `offset` | 0 | 分页 |
| `pool` | 空 | 只看含某玩法的单：`had` / `hhad` / `ttg` / `crs` / `hafu` |

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "12",
        "title": "2场 · 2串1",
        "passTypes": ["2串1"],
        "multiple": 2,
        "units": 1,
        "amount": 4,
        "maxBonus": 15.64,
        "placedAt": "2026-10-25T14:10:00.000Z",
        "matchCount": 2,
        "status": "won",
        "payout": 15.64,
        "passTypeDetails": [{ "passType": "2串1", "need": 2, "totalUnits": 1, "wonUnits": 1, "payout": 15.64 }],
        "legs": [
          {
            "id": "21",
            "sportteryMatchId": 2042217,
            "matchNo": "周日005",
            "homeName": "福图纳锡塔德",
            "awayName": "SBV精英",
            "pool": "had",
            "optionKey": "h",
            "optionLabel": "胜",
            "odds": 2.3,
            "goalLine": null,
            "outcome": "won",
            "result": { "settled": true, "homeScore": 1, "awayScore": 0, "homeHalfScore": 0, "awayHalfScore": 0 }
          }
        ]
      }
    ],
    "stats": { "total": 1, "pending": 0, "won": 1, "lost": 0, "amount": 4, "payout": 15.64 }
  }
}
```

`status`：`pending`（还有场次没开奖）/ `won` / `lost`；`stats` 只在 `offset=0` 时返回。

### 3.9 `GET /api/bets/stats`

「我的投注」顶部统计，需要登录。`GET /api/bets` 在 `offset=0` 时会顺带返回同一结构，单独拉一次的场景（如删除后刷新统计）用这个接口。

```json
{
  "success": true,
  "data": { "total": 3, "pending": 1, "won": 1, "lost": 1, "amount": 24, "payout": 15.64 }
}
```

字段：`total` 总单数、`pending` 待开奖、`won` 中奖、`lost` 未中、`amount` 总投入、`payout` 总奖金（已结算部分）。

### 3.10 `POST /api/bets`

保存一份投注单（方案快照）。**注数、金额、最高奖金由服务端重算**，不信任客户端传值。

`maxBonus` 与结算奖金都按体彩单注限额封顶：单场 10 万、2/3 串 20 万、4/5 串 50 万、6 串及以上 100 万；
倍数按多注处理，每一注各自封顶后相加。

```json
{
  "title": "周日两场",
  "passTypes": ["2串1"],
  "multiple": 2,
  "legs": [
    {
      "sportteryMatchId": 2042217,
      "matchNumStr": "周日005",
      "leagueName": "荷甲",
      "homeName": "福图纳锡塔德",
      "awayName": "SBV精英",
      "kickoffAt": "2026-10-25T19:00:00+08:00",
      "pool": "had",
      "optionKey": "h",
      "optionLabel": "胜",
      "odds": 2.3,
      "goalLine": null
    },
    { "sportteryMatchId": 2042216, "pool": "had", "optionKey": "h", "odds": 1.7 }
  ]
}
```

限制：最多 60 个选项 / 15 场 / 6 种过关方式；`odds` 必须 ≥ 1；`multiple` 1–50。
同一场选多个选项就是复式，`units` 按组合数计算。

响应 `201`，body 与列表中的单条结构一致（已带实时结算）。

#### 3.10.1 彩票选号（排列五 / 七星彩 / 大乐透，支持复式）

同一个 `POST /api/bets`，用 `kind: "lottery"` 区分（不传 `kind` 仍是足球）：

```json
{ "kind": "lottery", "game": "dlt", "numbers": { "main": [1, 6, 10, 15, 32, 33], "extra": [3, 8, 9] }, "multiple": 1 }
```

| 字段 | 说明 |
| --- | --- |
| `game` | `pl5` / `qxc` / `dlt`，也接受 gameNo `350133` / `04` / `85` |
| `numbers.main` | 排列五：5 个位次（每位 0–9）；七星彩：7 个位次，前六位 0–9、**末位 0–14**；大乐透：前区号码池（≥5 个，1–35） |
| `numbers.extra` | 只有大乐透使用：后区号码池（≥2 个，1–12） |

- **注数**：排列五/七星彩 = 各位数字个数的乘积；大乐透 = `C(前区个数,5) × C(后区个数,2)`。
  `multiple` 1–50；`units = 注数 × 倍数`，`amount = 2 × units`；单张最多 **1000 注（2000 元）**，超出 `400`。
- 号码由服务端再校验（位次非空、范围、大乐透排序去重），前端选号器只是输入辅助。
- 返回的单条结构：`kind: "lottery"`，`passTypes` / `legs` 为空，另带
  `lottery: { gameKey, gameNo, name, positional, mode, numbers, tier, tiers, winningUnits, hits, matchedMain, matchedExtra, draw }`。
- 判定：取 `placedAt` 之后该彩种第一场开奖（`lottery_draw`）。排列五 / 七星彩按位全中记一等奖；
  大乐透按官方九个奖级并用组合数算出中奖注数与各奖级注数。浮动奖金不代算，`payout` 恒为 `0`，以官方公告为准。

### 3.11 `GET /api/bets/:id`、`DELETE /api/bets/:id`

详情 / 删除（只能操作自己的单，越权返回 `404`）。

### 3.12 结算规则

- 赛果来自 `match_result`；缺失即 `pending`，不提前判负。
- 彩票单：取 `placedAt` 之后第一场开奖判定（排列五 / 七星彩全中；大乐透按九个奖级），
  浮动奖金不代算，`payout` 恒为 `0`。
- 每注 2 元，奖金 = 命中组合的赔率连乘 × 2 × 倍数。
- 让球胜平负按**下注时**的 `goalLine` 重算（2:1、让一球 → 1:1 → 让球平）。
- 复式每场多选时，最多只有一个选项能中，中奖注数 = 命中组合数。
- 比分玩法覆盖官方全部选项，包括「胜其它 / 平其它 / 负其它」。

### 3.13 微信登录与绑定

账号与登录方式已经拆开：`app_user` 是账号，`user_identity` 是「某种登录方式」。
邮箱是一个身份，微信是另一个身份；同一个账号可以同时拥有两者。

| 概念 | 说明 |
| --- | --- |
| `provider` | `email` / `wechat` |
| `channel` | `email` / `wechat_web`（开放平台扫码）/ `wechat_mp`（公众号网页授权） |
| `provider_uid` | 邮箱（小写）或微信 openid |
| `union_id` | 微信 unionid，同一开放平台下跨应用识别同一个人 |

#### `GET /api/auth/wechat/config`

公开接口，前端据此决定入口形态：

```json
{
  "success": true,
  "data": {
    "enabled": true,
    "channels": ["wechat_web", "wechat_mp"],
    "redirectUri": "https://ticai-service.vercel.app/api/auth/wechat/callback",
    "missing": []
  }
}
```

未配置时 `enabled` 为 `false`，`missing` 列出缺的环境变量（`WECHAT_APP_ID` / `WECHAT_APP_SECRET` / `WECHAT_REDIRECT_URI`），
`start` 等接口返回 `503`；前端在登录页与账号页改为展示「接入步骤」。

#### `GET /api/auth/wechat/start?mode=login|bind`

返回授权地址，前端直接跳转（新窗口/当前窗口都行）：

```json
{ "success": true, "data": { "authorizeUrl": "https://open.weixin.qq.com/connect/qrconnect?..." } }
```

- `mode=login`：扫码后登录；身份不存在时**自动建一个无邮箱账号**。
- `mode=bind`：必须带 `Authorization`，把微信绑到当前账号（不会新建账号）。

state 由服务端 HMAC 签名，内含 `mode`、渠道、绑定用户 id 与 10 分钟过期时间，防 CSRF 与串号。

#### `GET /api/auth/wechat/callback?code&state`

微信跳回来的地址（需与平台登记一致）。服务端完成 code → openid 交换后：

- 成功：`302` 到 `${APP_WEB_BASE}/auth/wechat?ticket=<一次性票据>&mode=login|bind`；
- 失败：`302` 到同地址并带 `error=`（中文原因）。

**URL 里只有 2 分钟、一次性的 ticket，不是会话 token**，避免 token 进浏览器历史与反代日志。

#### `POST /api/auth/wechat/session`

```json
{ "ticket": "…" }
```

消费票据并建立正式会话，响应与 `/api/auth/login` 相同（`token` / `expiresAt` / `user`）。票据重复使用返回 `400`。

#### `GET /api/auth/identities`、`DELETE /api/auth/identities/:provider`

```json
{
  "success": true,
  "data": {
    "items": [
      { "provider": "email", "channel": "email", "nickname": "me", "uidHint": "", "lastLoginAt": "2026-10-25T15:00:00.000Z" },
      { "provider": "wechat", "channel": "wechat_web", "nickname": "微信昵称", "uidHint": "…abcd", "lastLoginAt": null }
    ]
  }
}
```

- openid 只回末四位（`uidHint`）。
- 解绑时如果只剩最后一种登录方式，返回 `400 至少保留一种登录方式`。

#### 未接入微信时

服务端没有 `WECHAT_APP_ID` / `WECHAT_APP_SECRET` / `WECHAT_REDIRECT_URI` 时：

- `/api/auth/wechat/config` 返回 `enabled: false` 与 `missing: [...]`；
- 登录页的「微信登录」按钮不跳转，改为弹出**接入步骤**（注册开放平台 → 创建网站应用 →
  配置回调域与环境变量 → 重新部署）；
- 账号页显示「查看接入步骤」；
- 邮箱注册 / 密码登录 / 验证码登录 / 投注 / 结算完全不受影响。

接入步骤（详细版）：

1. 在 open.weixin.qq.com 注册并完成开发者资质认证（企业主体，需要已备案域名）；
2. 创建「网站应用」，授权回调域只填 API 域名（不带 `https://` 与路径）；
3. 部署环境配置：

   ```bash
   WECHAT_APP_ID=应用 AppID
   WECHAT_APP_SECRET=应用 AppSecret
   WECHAT_REDIRECT_URI=https://<API 域名>/api/auth/wechat/callback
   APP_WEB_BASE=https://<前端域名>
   ```

4. 重新部署 API 并刷新页面，`enabled` 变为 `true`，按钮直接跳扫码授权。

---

## 4. AI 接口

### 4.1 `POST /api/ai-analysis`（推荐）

> 实现位置：配置 `ANALYSIS_API_BASE` 时由 Python 分析服务处理（含 SSE 流式），响应头
> `x-analysis-via: python`；提示词两套实现逐字节一致（`npm run analysis:test` 对拍），
> LLM 输出本身不参与比较。不可达时回退 Node 内联实现。

**只收比赛 ID 和玩法**，其余全部服务端装配：比赛信息、最新赔率、官方数据（伤停/交锋/近况/排名）、比赛地天气、系统提示词。

**请求体**

```json
{
  "matchId": 2042119,
  "pool": "ttg",
  "stream": true,
  "thinking": false,
  "maxTokens": 1500,
  "temperature": 0.4
}
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `matchId` | int | 必填 | 体彩赛事 ID |
| `pool` | string | `ttg` | `had` / `crs` / `ttg` / `hafu` / `mixed` |
| `stream` | boolean | `false` | `true` 走 SSE |
| `thinking` | boolean | `false` | 是否开启模型思考模式（更慢更贵） |
| `maxTokens` | int | 1500 | 上限 2048 |
| `temperature` | number | 0.4 | 0–2 |

**SSE 响应**（`stream: true`）

```
event: meta
data: {"matchId":2042119,"pool":"ttg","weatherLabel":"Graz 14.5℃ 多云","promptChars":350,"hasOdds":true,"feeds":["history","injury","result","future","feature","tables","shooter"]}

event: content
data: {"delta":"【分析】"}

event: done
data: {"model":"deepseek-flash","finishReason":"stop","truncated":false,"usage":{"promptTokens":812,"completionTokens":700,"totalTokens":1512,"cachedTokens":512},"elapsedMs":8123}
```

`meta` 在生成前就发出，前端可以立刻显示天气、观察 `promptChars` 来控制成本。

**非流式响应**

```json
{
  "success": true,
  "data": {
    "content": "【分析】…",
    "reasoning": "",
    "model": "deepseek-flash",
    "finishReason": "stop",
    "truncated": false,
    "usage": { "promptTokens": 812, "completionTokens": 700, "totalTokens": 1512, "cachedTokens": 512 },
    "meta": { "weatherLabel": "Graz 14.5℃ 多云", "promptChars": 350 },
    "elapsedMs": 8123
  }
}
```

**提示词策略**（服务端 `apps/api/src/ai/prompt.mjs`）

- 系统提示词固定不变 → 命中 DeepSeek 前缀缓存（`cachedTokens`）；
- 只带当前玩法的赔率；`mixed` 不含 31 个比分选项，`crs` 只取 12 个；
- 交锋 ≤3 场、伤停每队 ≤4 人、近况每队 ≤4 场；射手/未来赛程不进提示词；
- **阵容**（若已导入）：只写两队首发名单与阵型，未确认的标注「预测」；
- 缺失的段落整行不写，不产生「暂无数据」噪音。

**限流**：`AI_RATE_LIMIT_PER_MIN`（默认 10 次/分钟/IP），超出返回 `429`。

### 4.2 `POST /api/ai-parlay`（串关）

> 实现位置：与 `/api/ai-analysis` 相同（`ANALYSIS_API_BASE` → Python，SSE 与 `meta` 事件一致）。

**只收选中的场次与选项**，联赛、开赛时间、赔率、伤停由服务端按 `matchId` 从库里补；系统提示词也在服务端。

**请求体**

```json
{
  "pool": "ttg",
  "passSummaryText": "3串1",
  "betAmount": 20,
  "maxBonus": 456.7,
  "stream": true,
  "entries": [
    {
      "matchId": 2042124,
      "matchNo": "周四006",
      "teams": "伯恩茅斯 vs AC米兰",
      "kickoffTime": "10-23 03:00",
      "options": [{ "label": "2球", "value": "3.85" }],
      "cachedAnalysis": "……可选，3 小时内的单场结论，服务端会复用"
    }
  ]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `entries` | array | 1–10 场，超出返回 `400` |
| `entries[].matchId` | int | 体彩赛事 ID，用于补赔率与伤停 |
| `entries[].options` | array | 每场 1–6 个，`label` ≤24 字、`value` ≤12 字 |
| `entries[].cachedAnalysis` | string | ≤900 字，标注「可复用」后交给模型 |
| `passSummaryText` | string | 过关方式，如 `3串1` |
| `betAmount` / `maxBonus` | number | 仅用于提示词里的方案概况 |
| `stream` | boolean | `true` 走 SSE |

**SSE 事件**：`meta`（`legs` / `matched` / `promptChars`）→ `content` 增量 → `done`；错误为 `error`。

**与遗留接口的区别**：`/api/ai-chat` 需要客户端自带完整 `messages`，改提示词要发版且请求体大；本接口只传结构化参数，提示词可随时在服务端迭代。

### 4.3 `POST /api/ai-chat`（遗留）

通用的 DeepSeek 代理，由客户端自带 `messages`。**前端已不再调用**（单场走 `/api/ai-analysis`、串关走 `/api/ai-parlay`），保留给脚本与第三方调试。

请求体与 `/api/ai-analysis` 类似，但用 `messages` 取代 `matchId`：

```json
{ "messages": [{ "role": "system", "content": "…" }, { "role": "user", "content": "…" }], "stream": true }
```

约束：`messages` ≤40 条、单条 ≤15000 字符、合计 ≤30000 字符；`json: true` 时提示词必须包含 `json` 字样。

---

## 5. 代理接口

这四个接口不落业务库，直接转发聚合数据 / DeepSeek / Open-Meteo，带 TTL 缓存。

### 5.1 `GET /api/horoscope`

| 参数 | 说明 |
| --- | --- |
| `consName` | 12 星座之一，如 `白羊座` |
| `type` | `today` / `tomorrow` / `week` / `month` / `year`，默认 `today` |

响应为统一信封，`data` 是聚合数据原始 body。缓存 10 分钟。缺密钥返回 `503`。

### 5.2 `GET /api/weather`

| 参数 | 说明 |
| --- | --- |
| `cityname` | 城市名，≤64 字符 |
| `dtype` / `format` | 透传给聚合数据（可空） |

缓存 10 分钟。缺密钥返回 `503`。

### 5.3 `GET /api/ip`

无参数，按连接 IP 查询归属地（私有网段不传 `ip`，由上游按来源判断）。

```json
{ "success": true, "data": { "ip": "1.2.3.4", "address": "中国 上海 上海", "details": { "city": "上海", "regionName": "上海", "country": "中国" } } }
```

未配置 `JUHE_IP_KEY` 时返回 `details: {}`，前端回退默认城市。缓存 30 分钟。
**注意**：服务前面必须有可信反代；直连公网时设 `TRUST_PROXY=0`，否则 `x-forwarded-for` 可伪造。

### 5.4 `GET /api/venue-weather`

> 实现位置：配置 `ANALYSIS_API_BASE` 时由 Python 分析服务计算并代理返回（响应头 `x-analysis-via: python`）；
> 未配置或不可达时回退 Node 内联实现。城市解析与天气字段完全一致。

主队城市由 DeepSeek 解析，天气来自 Open-Meteo。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `homeTeam` | 是 | 主队中文名 |
| `league` | 否 | 联赛名，提高解析准确率 |
| `kickoff` | 否 | 开赛时间（北京时间字符串） |
| `teamId` | 否 | 体彩球队 ID |

失败时返回 `available: false` + `reason`，不抛错（前端降级为「天气未获取」）。

---

## 6. 运维接口

### 6.1 `GET /api/health`（readiness）

```json
{
  "success": true,
  "data": {
    "uptimeSeconds": 3600,
    "node": "v20.19.0",
    "db": "up",
    "dataSources": [{ "source": "sporttery.matches", "lastOkAt": "2026-10-22T07:00:00.000Z", "ageSeconds": 42 }],
    "analysis": { "total": 13, "stale": 0, "lastComputedAt": "2026-10-27T13:39:12.637Z" }
  }
}
```

数据库不可用时返回 `503`。**不暴露上游地址、模型名与密钥状态。**

### 6.2 `GET /healthz`（liveness）

```json
{ "ok": true, "uptimeSeconds": 3600 }
```

永远 200，不碰数据库，给探活用。

---

## 7. 前端接入

所有请求都经过 `src/api/base.ts` 的 `apiUrl()`：

```ts
// 同源（本地 Next rewrite → 127.0.0.1:3001 / 生产同域 rewrite）
NEXT_PUBLIC_API_BASE=

// 前后端分开部署
NEXT_PUBLIC_API_BASE=https://ticai-api.vercel.app
```

`NEXT_PUBLIC_` 变量会打进浏览器 bundle，只能放域名，**不能放任何密钥**。

---

## 8. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-30 | 新增 `GET /api/match-signals`：投注页「赔率接近」标注，每个玩法最低两档差 ≤8% 时标 `≈`，分析偏向由推荐引擎的融合概率决定（近况/伤停修正） |
| 2026-10-30 | 新增 `GET /api/odds-distribution`：开奖记录 × 总进球赔率分布（最低 / 倒数第二低 / 第三低 / 中奖赔率 + 排名），不限时间；`match_result` 新增固化赔率列，赛果入库时保存停售前最后一份 TTG 赔率 |
| 2026-10-29 | `/api/recommendations` 增加 `goalExpectation`（主客场进球 / 对手失球 / 联赛节奏 → 期望总进球），总进球按修正分布选选项；推荐面板加骨架屏、进度过渡与被过滤候选的「手动加入」 |
| 2026-10-29 | `/api/analysis/lottery` 新增 `w=` 自定义权重参数；前端删除 TS 分析实现与 `sync-analysis` 生成链，权重滑块改为 400ms 防抖调服务端 |
| 2026-10-29 | 单场/串关 AI 分析（`/api/ai-analysis`、`/api/ai-parlay`）迁到 Python 分析服务，SSE 协议与 `meta` 事件不变；提示词逐字节对拍 |
| 2026-10-29 | 大乐透推演（`kind=dlt`）与 `/api/venue-weather` 迁到 Python 分析服务；三条分析路径全部由 `ANALYSIS_API_BASE` 代理，Node 保留同口径回退实现 |
| 2026-10-29 | 新增 `GET /api/recommendations`：投注推荐搬到服务端（幂法去水 + 伤停/近况有界修正 + 串关风控 + 同口径回测），前端不再本地算概率 |
| 2026-10-29 | 推荐引擎迁到 Python 分析服务（`apps/analysis`，Vercel 项目 `ticai-analysis`），Node 通过 `ANALYSIS_API_BASE` 反向代理；两套实现对拍一致，删变量即可回滚 |
| 2026-10-29 | 验证码登录即注册：未注册邮箱用验证码登录会建「无密码」账号；新增 `POST /api/auth/password`（设置/修改密码，验证码登录的会话可免当前密码重设）与 `POST /api/auth/email`（给微信账号绑定邮箱）；用户对象新增 `hasPassword`，`email_code.purpose` 新增 `bind`，`user_session` 记录 `verified_by` |
| 2026-10-27 | 新增 `/api/analysis/lottery`（+`/snapshots`）：开奖分析快照，爬虫开奖后算一次并带溯源（基于哪期/哪天/多少期样本） |
| 2026-10-27 | 前端改走同源 `/api`（`vercel.json` rewrite 到 `ticai-service`），接口地址不再写进 bundle |
| 2026-10-26 | 新增 `/api/bets/stats`；投注奖金按体彩单注限额封顶 |
| 2026-10-25 | 新增微信登录 / 绑定：`/api/auth/wechat/*`、`/api/auth/identities`，回调只发一次性 ticket |
| 2026-10-25 | 新增 `/api/results`：赛果开奖入库（`match_result`），由爬虫 `results` 链路写入，替代逐场抓近期赛果 |
| 2026-10-25 | 新增可选登录：`/api/auth/code|register|login|logout|me`，Resend 发邮箱验证码，Bearer 会话 |
| 2026-10-25 | 新增 `/api/bets` 系列：保存投注单、按玩法筛选、按赛果自动判中奖与奖金 |
| 2026-10-22 | 新增 `/api/ai-analysis`：只收 `matchId + pool`，提示词与官方数据下沉服务端；前端请求数 3 → 1 |
| 2026-10-22 | 新增 `/api/match-detail`：对战详情 7 个板块，缺失返回 `null` + `missing` |
| 2026-10-22 | `/api/matches`、`/api/history` 改为读库；金额字段双写修复旧前端显示 |
| 2026-10-21 | `/api/ai-chat` 支持 SSE 思考流；`/api/venue-weather` 上线 |
