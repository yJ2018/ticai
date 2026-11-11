-- ============================================================================
-- 0014：福彩双色球 / 快乐8 接入 + 推荐命中归档
--
-- 一、彩种来源
--   体彩（排列三/五、七星彩、大乐透）与福彩（双色球、快乐8）来自两套官方接口，
--   号码结构与开奖节奏也不同。这里只给字典加两个稳定字段，分析/展示仍按号码结构走：
--     source   = sporttery | cwl   —— 爬虫按它选择上游接口
--     category = sports    | welfare —— 前端按它分组（体彩 / 福彩）
--
-- 二、推荐命中归档
--   位次型彩种（排列五 / 七星彩）已有 lottery_prediction_track：
--   每期记录逐位 Top1/Top3，组合按位匹配。
--   双色球、快乐8、大乐透是「号码池」结构，命中口径完全不同：
--     · 大乐透：主推 5+2 单注，命中前区几个 / 后区几个，按九个奖级定档；
--     · 双色球：红球 12 码池 + 蓝球 4 码池，记录覆盖几个开奖号；
--     · 快乐8：选十 10 码，记录命中几个（0–10），按选十奖级定档。
--   这里新建一张通用的逐期推荐归档表，与位次型归档并存：
--     lottery_recommendation_track       每期一行：推荐 / 实际 / 命中 / 奖级
--     lottery_recommendation_track_stat  每彩种一行：累计命中 + 最近 1000 期
--
--   归档仍是 walk-forward：第 N 期的推荐只使用第 N-1 期及以前的数据，
--   through_issue 记录截点，可以自证没有偷看当期。
--
-- 幂等：同一 (game_no, config_key, issue) 只留一行；回填/补算是 upsert。
-- ============================================================================

-- ── 一、彩种来源 ────────────────────────────────────────────────────────────

alter table lottery_game
  add column if not exists source text not null default 'sporttery';

alter table lottery_game
  add column if not exists category text not null default 'sports';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'lottery_game_source_chk'
  ) then
    alter table lottery_game
      add constraint lottery_game_source_chk
      check (source in ('sporttery', 'cwl'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'lottery_game_category_chk'
  ) then
    alter table lottery_game
      add constraint lottery_game_category_chk
      check (category in ('sports', 'welfare'));
  end if;
end
$$;

comment on column lottery_game.source is '数据来源：sporttery=体彩官方，cwl=福彩官方';
comment on column lottery_game.category is '展示分组：sports=体彩，welfare=福彩';

-- ── 二、号码池型推荐命中归档 ────────────────────────────────────────────────

create table if not exists lottery_recommendation_track (
  game_no           text not null references lottery_game(game_no) on delete cascade,
  -- 参数指纹（目前只有 window=300；按 kind 区分算法）
  config_key        text not null,
  -- 推荐算法：dlt / ssq / kl8
  kind              text not null,
  -- 被预测的那一期（开奖后核对）
  issue             text not null,
  issue_seq         bigint not null,
  draw_date         date not null,

  -- ── 溯源：这份推荐只吃到了哪一期 ──
  through_issue     text,
  through_issue_seq bigint,

  -- ── 推荐 / 实际 / 命中 ──
  -- prediction: {"main":[..],"extra":[..],"primaryMain":[..],"primaryExtra":[..]}
  prediction        jsonb not null,
  -- actual: {"main":[..],"extra":[..]}
  actual            jsonb not null,
  -- hits: {"main":2,"extra":1,"total":3}
  hits              jsonb not null,
  -- ticket: {"tier":"四等奖","tiers":[{"tier":"四等奖","units":1}],"winningUnits":1}
  ticket            jsonb not null default '{}'::jsonb,

  engine_version    text not null,
  engine_digest     text not null,
  computed_at       timestamptz not null default now(),

  primary key (game_no, config_key, issue),
  constraint recommendation_track_issue_seq_chk check (issue_seq > 0),
  constraint recommendation_track_kind_chk check (kind in ('dlt', 'ssq', 'kl8'))
);

comment on table lottery_recommendation_track is
  '号码池型彩种逐期推荐命中（大乐透 / 双色球 / 快乐8）；walk-forward，开奖后核对';

create index if not exists recommendation_track_latest_idx
  on lottery_recommendation_track (game_no, config_key, issue_seq desc);

-- 汇总表：累计命中 + 最近 1000 期逐期命中 + 命中分布。
-- state 是增量计算的输入（累计计数 + 最近命中），payload 是接口直出的统计对象；
-- 分开存是为了接口不把增量状态发给浏览器。
create table if not exists lottery_recommendation_track_stat (
  game_no           text not null references lottery_game(game_no) on delete cascade,
  config_key        text not null,
  kind              text not null,
  through_issue     text not null,
  through_issue_seq bigint not null,
  samples           integer not null,
  payload           jsonb not null,
  state             jsonb not null,
  engine_version    text not null,
  engine_digest     text not null,
  computed_at       timestamptz not null default now(),

  primary key (game_no, config_key),
  constraint recommendation_track_stat_samples_chk check (samples > 0),
  constraint recommendation_track_stat_kind_chk check (kind in ('dlt', 'ssq', 'kl8'))
);

comment on table lottery_recommendation_track_stat is
  '号码池型推荐命中汇总：累计命中 / 最近 1000 期窗口 / 奖级分布';

-- 巡检视图：每个彩种/参数归档到哪一期、多少期、平均命中多少
create or replace view lottery_recommendation_track_latest as
select
  s.game_no,
  g.game_key,
  g.name as game_name,
  s.kind,
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
from lottery_recommendation_track_stat s
join lottery_game g on g.game_no = s.game_no
left join lateral (
  select dd.issue, dd.issue_seq, dd.draw_date
  from lottery_draw dd
  where dd.game_no = s.game_no
  order by dd.issue_seq desc
  limit 1
) d on true;
