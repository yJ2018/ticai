-- ============================================================================
-- 0013：逐期参考号码归档（命中率 / 偏差分析）
--
-- 为什么要有这张表：
--   `lottery_analysis_snapshot` 只保留「基于最新一期算出来的下一期参考」，
--   没有把每一期的参考和当期开奖对上，所以只能看到全量回测的汇总命中率，
--   看不到「哪个号码被高估 / 哪一位在漂移 / 哪一期差一点」。
--   这里把每一期开奖前给出的参考号码、逐位命中、组合命中全部落库：
--     issue 期 = 该期开奖结果；
--     参考由「上一期为止」的数据 walk-forward 算出（through_issue 记录截点，证明没用到当期）。
--
-- 数据量：排列五 7766 期 × 5 位 × 3 个候选，一行约 0.4–0.8 KB，整表约 5 MB；
-- 加上汇总 state（累计计数 + 最近 1000 期命中）也只有几百 KB。
--
-- 幂等：同一 (game_no, config_key, issue) 只留一行；回填/补算是 upsert。
-- ============================================================================

create table if not exists lottery_prediction_track (
  game_no           text not null references lottery_game(game_no) on delete cascade,
  -- 参数指纹，与 lottery_analysis_snapshot.config_key 同一套（默认 markov=2）
  config_key        text not null,
  -- 被预测的那一期（开奖后核对）
  issue             text not null,
  issue_seq         bigint not null,
  draw_date         date not null,

  -- ── 溯源：这份参考只吃到了哪一期 ──
  through_issue     text,
  through_issue_seq bigint,

  -- ── 结果 ──
  actual            jsonb not null,   -- [7,2,0,9,7]，七星彩末位允许 10–14
  positions         jsonb not null,   -- [{position,picks:[3],actual,rank,hitTop1,hitTop3}]
  combinations      jsonb not null,   -- [{value:"72097", matched:4}]
  top1_hits         smallint not null, -- 本期 Top1 命中了几位
  top3_hits         smallint not null, -- 本期 Top3 命中了几位
  best_combo_match  smallint not null, -- 6 注组合里最好的一注对了几位

  engine_version    text not null,
  engine_digest     text not null,
  computed_at       timestamptz not null default now(),

  primary key (game_no, config_key, issue),
  constraint prediction_track_issue_seq_chk check (issue_seq > 0),
  constraint prediction_track_hits_chk check (top1_hits between 0 and 7 and top3_hits between 0 and 7),
  constraint prediction_track_combo_chk check (best_combo_match between 0 and 7)
);

-- 翻页对齐：按彩种/参数倒序取最近 N 期
create index if not exists prediction_track_latest_idx
  on lottery_prediction_track (game_no, config_key, issue_seq desc);

-- 汇总表：累计命中 + 最近 1000 期逐期命中 + 号码偏差矩阵。
-- state 是增量计算的输入（累计计数 + 最近命中），payload 是接口直出的统计对象；
-- 分开存是为了接口不把 30 KB 的增量状态发给浏览器。
create table if not exists lottery_prediction_track_stat (
  game_no        text not null references lottery_game(game_no) on delete cascade,
  config_key     text not null,
  through_issue  text not null,
  through_issue_seq bigint not null,
  samples        integer not null,
  payload        jsonb not null,
  state          jsonb not null,
  engine_version text not null,
  engine_digest  text not null,
  computed_at    timestamptz not null default now(),

  primary key (game_no, config_key),
  constraint prediction_track_stat_samples_chk check (samples > 0)
);

-- 巡检视图：每个彩种/参数归档到哪一期、多少期、命中率多少
create or replace view lottery_prediction_track_latest as
select
  s.game_no,
  g.game_key,
  g.name as game_name,
  s.config_key,
  s.through_issue,
  s.through_issue_seq,
  s.samples,
  s.engine_version,
  s.engine_digest,
  s.computed_at,
  s.payload,
  d.issue as latest_issue,
  d.issue_seq as latest_issue_seq,
  d.draw_date as latest_draw_date
from lottery_prediction_track_stat s
join lottery_game g on g.game_no = s.game_no
left join lateral (
  select dd.issue, dd.issue_seq, dd.draw_date
  from lottery_draw dd
  where dd.game_no = s.game_no
  order by dd.issue_seq desc
  limit 1
) d on true;
