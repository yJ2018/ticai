-- ============================================================================
-- 0007：开奖分析快照
--
-- 为什么要有这张表：
--   分析（频次/遗漏/马尔可夫/滚动回测、大乐透 5+2 推演）必须用**全量**历史，
--   排列五现在 7760 期。放在浏览器里算有三个硬伤：
--     1. 首屏要先把 78 页开奖翻完（约 140s）才拿得到全量样本；
--     2. 样本数取决于「进场时本地缓存里有多少」，同一个 URL 不同人不同数；
--     3. 每次重算全量回测在手机上要好几秒。
--   而结果只在「多了一期开奖」时才变——天然适合开奖后算一次、存下来、接口直读。
--
-- 溯源是这张表的重点：每条快照都记清自己基于哪一期末号、哪一天、多少期样本，
-- 前端可以直接展示「基于 26285 期 · 2026-10-26 · 7760 期样本」，而不是猜。
--
-- 幂等：同一 (game_no, kind, config_key, through_issue) 只留一行；
-- 重算是 upsert，不会因为爬虫重跑而堆垃圾。
-- ============================================================================

create table if not exists lottery_analysis_snapshot (
  id                bigint generated always as identity primary key,
  game_no           text not null references lottery_game(game_no) on delete cascade,
  -- 分析种类：prediction（频次+遗漏+马尔可夫+回测）/ math_trend（数学走势）/ dlt（大乐透 5+2 推演）
  kind              text not null,
  -- 参数指纹，例如 markov=2 / order=3；同一期不同参数各存一条，互不覆盖
  config_key        text not null,

  -- ── 溯源：这条结果吃的是哪段数据 ──
  through_issue     text not null,                    -- 样本最后一期（期号）
  through_issue_seq bigint not null,                  -- 同上，数值化，用于取「最新」
  through_draw_date date not null,                    -- 样本最后一次开奖日（这就是「基于哪一天的数据」）
  from_issue        text,                             -- 样本第一期
  from_issue_seq    bigint,
  from_draw_date    date,
  draw_count        integer not null,                 -- 实际参与计算的期数

  -- ── 结果 ──
  payload           jsonb not null,                   -- 与前端 analyze* 返回值同构，前端可直接渲染
  meta              jsonb not null default '{}'::jsonb, -- 耗时、引擎版本、附加说明

  -- ── 记账 ──
  source            text not null default 'crawler',  -- 'crawler' | 'cli' | 'api'
  crawl_run_id      bigint references crawl_run(id) on delete set null, -- 哪一轮抓取触发的
  duration_ms       integer,
  computed_at       timestamptz not null default now(),

  constraint lottery_analysis_snapshot_key unique (game_no, kind, config_key, through_issue),
  constraint lottery_analysis_kind_chk check (kind in ('prediction', 'math_trend', 'dlt')),
  constraint lottery_analysis_source_chk check (source in ('crawler', 'cli', 'api')),
  constraint lottery_analysis_count_chk check (draw_count > 0)
);

-- 取最新：where game_no/kind/config_key → order by through_issue_seq desc limit 1
create index if not exists analysis_snapshot_latest_idx
  on lottery_analysis_snapshot (game_no, kind, config_key, through_issue_seq desc);

-- 按彩种/时间巡检：/api/health 或 db:status 看「最新一条快照是什么时候算的」
create index if not exists analysis_snapshot_recent_idx
  on lottery_analysis_snapshot (computed_at desc);

-- 观察用视图：每个彩种每种分析的最新快照 + 库里最后一期开奖，一眼看出分析有没有落后
create or replace view lottery_analysis_latest as
select distinct on (s.game_no, s.kind, s.config_key)
  s.game_no,
  g.game_key,
  g.name                                          as game_name,
  s.kind,
  s.config_key,
  s.through_issue,
  s.through_issue_seq,
  s.through_draw_date,
  s.draw_count,
  s.source,
  s.duration_ms,
  s.computed_at,
  s.id,
  d.issue                                         as latest_issue,
  d.issue_seq                                     as latest_issue_seq,
  d.draw_date                                     as latest_draw_date
from lottery_analysis_snapshot s
join lottery_game g on g.game_no = s.game_no
left join lateral (
  select dd.issue, dd.issue_seq, dd.draw_date
  from lottery_draw dd
  where dd.game_no = s.game_no
  order by dd.issue_seq desc
  limit 1
) d on true
order by s.game_no, s.kind, s.config_key, s.through_issue_seq desc;
