# ticai API 接口文档

> 版本：2026-10-22 · 服务端代码在 `apps/api/`，实现细节见 [apps/api/README.md](../apps/api/README.md)

## 1. 基础信息

| 项 | 说明 |
| --- | --- |
| Base URL | 本地 `http://127.0.0.1:3001`；生产为 API 域名（前端通过 `VITE_API_BASE` 指向它） |
| 认证 | **无**（个人项目）。`/api/ai-analysis`、`/api/ai-chat` 依赖服务端密钥与 IP 限流 |
| 跨域 | `CORS_ORIGINS` 白名单；留空表示只允许同源。允许的方法 `GET,POST,OPTIONS` |
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

**C. SSE**（`/api/ai-analysis`、`/api/ai-chat` 且 `stream: true`）

```
event: meta
data: {"matchId":2042119,"pool":"ttg","weatherLabel":"Graz 14.5℃ 多云","promptChars":350}

event: content
data: {"delta":"【分析】"}

event: done
data: {"model":"deepseek-flash","finishReason":"stop","truncated":false,"usage":{...},"elapsedMs":8123}
```

事件类型：`meta`（仅 `/api/ai-analysis`）、`reasoning`、`content`、`done`、`error`。
首个增量之前不写响应头，因此参数/限流/鉴权错误仍以普通 JSON 返回。

### 1.2 通用响应头

| 头 | 出现位置 | 说明 |
| --- | --- | --- |
| `x-request-id` | 所有响应 | 排障用，错误时也返回 |
| `x-cache` | `/api/matches`、`/api/history`、`/api/horoscope`、`/api/weather`、`/api/ip` | `hit` / `miss` |
| `x-data-as-of` | `/api/matches` | 库中这批数据的最后抓取时间（ISO） |
| `x-match-count` | `/api/matches` | 本次返回场次数 |

### 1.3 错误码

| 状态 | 含义 |
| --- | --- |
| `400` | 参数非法（缺参、类型错、枚举外） |
| `404` | 接口不存在 / 彩种不存在 / 比赛未入库 |
| `405` | 方法不允许（响应带 `allow` 头） |
| `413` | 请求体过大 |
| `429` | 触发限流（AI 类接口，按 IP） |
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
| 防爆破 | 同 IP 15 次/分、同邮箱 8 次/分（注册 10 次/小时/IP）；未知邮箱也会跑一次 scrypt，响应时间不泄露邮箱是否存在 |

> 本地用 `http://127.0.0.1:5199` 调试时，密码在回环网卡上是明文——只有你自己这台机器能看到。
> 用 `vite --host` 暴露到局域网时请确保信任同网段设备，或改用 HTTPS 隧道（如 cloudflared）。

### 3.2 `POST /api/auth/code`

发邮箱验证码。

```json
{ "email": "me@example.com", "purpose": "register" }
```

`purpose`：`register`（注册验证）或 `login`（免密登录）。响应：

```json
{ "success": true, "data": { "sent": true, "delivered": true, "expiresInSeconds": 600 } }
```

- 未配置 `RESEND_API_KEY` 时 `delivered=false`，验证码只写服务端日志；
  本地 `MAIL_DEV_ECHO=1` 会额外返回 `devCode`（**线上必须关闭**）。
- 限流：同邮箱 60 秒冷却、每小时 6 次；同 IP 每小时 20 次，超出返回 `429`。

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
    "user": { "id": "1", "email": "me@example.com", "createdAt": "2026-10-25T14:01:36.311Z" }
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

密码错误返回 `401 邮箱或密码不正确`；验证码错误/过期/超次返回 `400` / `429`。

### 3.5 `POST /api/auth/logout`、`GET /api/auth/me`

- `logout`：吊销当前 token，返回 `{ "ok": true }`。
- `me`：返回当前登录用户，用于刷新页面后校验本地 token。

### 3.6 `GET /api/bets`

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

### 3.7 `POST /api/bets`

保存一份投注单（方案快照）。**注数、金额、最高奖金由服务端重算**，不信任客户端传值。

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

### 3.8 `GET /api/bets/:id`、`DELETE /api/bets/:id`

详情 / 删除（只能操作自己的单，越权返回 `404`）。

### 3.9 结算规则

- 赛果来自 `match_result`；缺失即 `pending`，不提前判负。
- 每注 2 元，奖金 = 命中组合的赔率连乘 × 2 × 倍数。
- 让球胜平负按**下注时**的 `goalLine` 重算（2:1、让一球 → 1:1 → 让球平）。
- 复式每场多选时，最多只有一个选项能中，中奖注数 = 命中组合数。
- 比分玩法覆盖官方全部选项，包括「胜其它 / 平其它 / 负其它」。

### 3.10 微信登录与绑定

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

这三个接口不落库，直接转发聚合数据（Juhe），带 TTL 缓存。

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
    "dataSources": [{ "source": "sporttery.matches", "lastOkAt": "2026-10-22T07:00:00.000Z", "ageSeconds": 42 }]
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
// 同源（本地 Vite 代理 / 生产同域 rewrite）
VITE_API_BASE=

// 前后端分开部署
VITE_API_BASE=https://ticai-api.vercel.app
```

`VITE_` 变量会打进浏览器 bundle，只能放域名，**不能放任何密钥**。

---

## 8. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-25 | 新增 `/api/results`：赛果开奖入库（`match_result`），由爬虫 `results` 链路写入，替代逐场抓近期赛果 |
| 2026-10-25 | 新增可选登录：`/api/auth/code|register|login|logout|me`，Resend 发邮箱验证码，Bearer 会话 |
| 2026-10-25 | 新增 `/api/bets` 系列：保存投注单、按玩法筛选、按赛果自动判中奖与奖金 |
| 2026-10-22 | 新增 `/api/ai-analysis`：只收 `matchId + pool`，提示词与官方数据下沉服务端；前端请求数 3 → 1 |
| 2026-10-22 | 新增 `/api/match-detail`：对战详情 7 个板块，缺失返回 `null` + `missing` |
| 2026-10-22 | `/api/matches`、`/api/history` 改为读库；金额字段双写修复旧前端显示 |
| 2026-10-21 | `/api/ai-chat` 支持 SSE 思考流；`/api/venue-weather` 上线 |
