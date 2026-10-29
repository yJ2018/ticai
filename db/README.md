# ticai 数据库

PostgreSQL 15+。这一层是三件事的唯一交汇点：

```
爬虫（竞彩赛程/赔率/赛果、开奖、伤病、阵容） ──写──▶ 数据库 ──读──▶ API（Vercel）──▶ 前端
```

API 不直接访问体彩，`VITE_SPORTTERY_DIRECT` 那套直连妥协已经删除。

---

## 快速开始

```bash
npm install                      # 首次需要，pg 依赖
# ⚠️ 这一步会改写 package-lock.json。本地运行后务必把 lock 一起提交，
#    否则 Vercel 的 npm ci 会因 package.json / lock 不同步而构建失败。

# .env 里配好 DATABASE_URL（参考 .env.example）
npm run db:migrate               # 建表 + 种子彩种
npm run db:status                # 看已应用迁移、各表行数、抓取新鲜度
npm run db:verify                # 结构与约束自检（用事务夹具，跑完回滚）
```

日常维护（建议由爬虫收尾时或每日 cron 执行）：

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/maintenance.sql
```

---

## 目录

| 路径 | 作用 |
| --- | --- |
| `db/migrations/0001_init.sql` | 全量 schema：彩票域、足球域、可观测性、视图 |
| `db/migrations/0002_match_feed.sql` | 对战数据原始订阅源（7 类 feed）+ `player.sporttery_person_id` |
| `db/migrations/0003_match_result.sql` | 竞彩赛果开奖：比分 + `had/hhad/ttg/crs/hafu` 结果 + 关联 `match` |
| `db/migrations/0004_auth_bets.sql` | 可选登录（`app_user` / `email_code` / `user_session`）与投注单（`bet` / `bet_leg`） |
| `db/migrations/0005_identities_wechat.sql` | 第三方身份（`user_identity`）+ 一次性登录票据（`auth_ticket`）；`app_user.email` 允许为空 |
| `db/migrations/0006_wechat_password_nullable.sql` | 微信建的账号没有密码，`password_hash` 允许为空 |
| `db/migrations/0007_analysis_snapshot.sql` | 开奖分析快照 `lottery_analysis_snapshot` + `lottery_analysis_latest` 视图 |
| `db/migrations/0008_code_signup_password.sql` | 验证码登录即注册：`email_code.purpose` 增加 `bind`，`user_session.verified_by`，`app_user.password_updated_at` |
| `db/seed/001_lottery_games.sql` | 四个彩种字典（gameNo 已逐个实测） |
| `db/maintenance.sql` | 保留策略与巡检查询 |
| `scripts/db-migrate.mjs` | 迁移执行器：`up` / `seed` / `status` / `verify` |

迁移器行为：每个文件一个事务、失败整体回滚、`schema_migration` 记录 checksum、全程持 advisory lock，两个进程同时部署不会互相踩。

---

## 上游接口实况（2026-10-22 实测，写爬虫前先看这段）

### gameNo 已验证

| gameNo | 彩种 | 号码形态 | 历史期数 |
| --- | --- | --- | --- |
| `35` | 排列3 | `8 6 4`（3 位，位置型） | 7755 |
| `350133` | 排列5 | `8 6 4 0 3`（5 位，位置型） | 7755 |
| `85` | 超级大乐透 | `01 06 10 15 32 03 04`（前 5 + 后 2） | 2938 |
| `04` | 七星彩 | `8 9 1 1 5 9 5`（7 位，位置型） | 3404 |

排列3 与排列5 **共用期号体系**（同期号都是 `26280`），所以主键必须是 `(game_no, issue)`。

### 567 是请求头指纹，不是 IP 封锁

实测：不带 `Referer` 时返回 **HTTP 567**；加上下面这组头立刻 200：

```
user-agent: Mozilla/5.0 ... Chrome/131.0.0.0 Safari/537.36
referer: https://www.sporttery.cn/
origin: https://www.sporttery.cn
accept-language: zh-CN,zh;q=0.9
```

这意味着 Vercel 的 567 **可能也不全是 IP 问题**——上线前值得在函数里用这套头复测一次。

### 字段名和现有前端对不上（真实 bug）

| 数据库列 | 上游真实字段 | 现有前端读的字段 |
| --- | --- | --- |
| `sales_amount` | `totalSaleAmount`（`"314,954,142"`） | `lotterySaleAmount` ❌ 不存在 |
| `pool_balance` | `poolBalance` | `poolAmount` ❌ 不存在 |

所以目前 `/history` 页的「销售额 / 奖池」一直显示 `--`。爬虫按左列写库即可，前端改读接口即可修好。

### 奖级字段

```json
{ "prizeLevel": "一等奖(追加)", "sort": 201,
  "stakeCount": "1", "stakeAmountFormat": "8000000", "totalPrizeamount": "8000000" }
```

`prizeLevel` 是中文名且天然唯一（一等奖 / 一等奖(追加) / 直选 / 组选3），直接做 `prize_key`；`sort` 入库为 `sort_no` 用于排序。大乐透的追加奖级就在同一个 `prizeLevelList` 里，不用读 `prizeLevelListRj`。

---

## 写入契约

爬虫必须遵守两条，否则数据会越写越乱：

1. **幂等**：全部 `on conflict` 更新，重跑同一天不产生重复。
2. **事务**：一批一个事务；比赛先 upsert，再算赔率 hash，变了才插快照。

```sql
-- 开奖：自然键 (game_no, issue)
insert into lottery_draw
  (game_no, issue, issue_seq, draw_date, main_numbers, extra_numbers, numbers_text, sales_amount, raw)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
on conflict (game_no, issue) do update set
  draw_date     = excluded.draw_date,
  main_numbers  = excluded.main_numbers,
  extra_numbers = excluded.extra_numbers,
  numbers_text  = excluded.numbers_text,
  sales_amount  = excluded.sales_amount,
  raw           = excluded.raw,
  updated_at    = now()
returning id;

-- 奖级：整体替换最简单可靠
delete from lottery_prize_level where draw_id = $1;
insert into lottery_prize_level (draw_id, prize_key, sort_no, stake_count, prize_amount, total_amount)
select $1, * from unnest($2::text[], $3::int[], $4::bigint[], $5::numeric[], $6::numeric[]);

-- 赛事：自然键 sporttery_match_id，注意刷新 last_seen_at
insert into match (sporttery_match_id, business_date, match_num_str, kickoff_at, league_name,
                   home_team_id, away_team_id, home_name, away_name, raw)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
on conflict (sporttery_match_id) do update set
  kickoff_at  = excluded.kickoff_at,
  raw         = excluded.raw,
  sell_status = 'on_sale',
  last_seen_at = now(),
  updated_at  = now();
```

**时间必须显式 `+08:00`**：`business_date` 是日期、`matchTime` 只有时分秒，在 UTC 进程里拼出来会整体差 8 小时。

**赔率只写变化**：对归一化后的赔率对象做稳定序列化 → `sha256` → `on conflict (match_id, content_hash) do nothing`。内容没变就一行都不写。

---

## 保留策略

| 表 | 策略 | 原因 |
| --- | --- | --- |
| `match_lineup` | **每队只留最近 1 场** | 你的需求是"只看最近"；一场 36 行，不裁会一直涨 |
| `match_odds_snapshot` | 120 天 | 一场每天 30-80 次变更，是唯一会失控的表 |
| `crawl_run` | 30 天 | 只用于排障和新鲜度判断 |
| `injury` | 未愈 + 近 1 年 | 历史伤病仅用于球员耐用度标签 |
| `lottery_draw` | 永久 | 四个彩种合计约 1.7 万期，毫无压力 |
| `lottery_analysis_snapshot` | 永久 | 每期 × 每参数一条（约 11 KB），一年 ~80 MB；留着可以回看「当时模型怎么推的」 |

全部在 `db/maintenance.sql`，已实测：3 条阵容 + 3 条明细 → 清理后各剩 1 条，明细随外键级联删除。

---

## 权限分离

API 被攻破时，最坏结果应该是"只读数据泄漏"。

```sql
create role ticai_api login password '...';
grant select on all tables in schema public to ticai_api;
grant update (venue_city, venue_lat, venue_lon, venue_tz, venue_source, venue_resolved_at)
  on team to ticai_api;          -- AI 场馆解析结果需要回写，只给这几列

create role ticai_crawler login password '...';
grant select, insert, update, delete on all tables in schema public to ticai_crawler;
grant usage, select on all sequences in schema public to ticai_crawler;
```

---

## 已验证 / 未验证

在 PostgreSQL 18.3 上实跑通过：

- 迁移 + 种子 + 重复执行幂等
- `htft` 生成列：2:1 / 半场 0:0 → `dh`
- `match_side` 客队视角翻转：`dh` → `da`
- `(game_no, issue)` 唯一约束、赔率 `(match_id, content_hash)` 去重
- `lateral` 多彩种取最近 N 期、大乐透前区频次统计
- `db/maintenance.sql` 全量执行、阵容裁剪与级联删除
- `npm run db:verify` 7 项自检全绿

**已接线**：API 读库层（`apps/api/src/repos/`）与爬虫本体（`apps/crawler`）都已按上面的契约落地，迁移文件覆盖 `0001_init` → `0008_code_signup_password`，`npm run db:verify` 7 项自检全绿。数据库当前共 24 张表 + 3 个视图（`match_side` / `match_odds_latest` / `lottery_analysis_latest`）。

账号链路的三条新约定（`0008`）：

- `email_code.purpose`：`register`（注册）/ `login`（免密登录，**邮箱未注册时会自动建号**）/ `bind`（给当前账号绑定邮箱）；
- `user_session.verified_by`：会话是怎么建立的（`password` / `code` / `wechat`）。验证码登录的会话改密码时不用给当前密码，其余会话必须验一次；
- `app_user.password_updated_at`：密码最后设置时间。`password_hash` 仍可为空（微信建的号、验证码登录自动建的号）。
