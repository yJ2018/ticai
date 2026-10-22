-- ============================================================================
-- ticai · 数据库初始化（PostgreSQL 15+）
--
-- 设计前提（2026-10 决议）：
--   1. 服务端继续部署在 Vercel，体彩取数由独立爬虫完成，API 只读库；
--   2. 足球部分只入库竞彩赛事（match 以体彩 matchId 为主键来源）；
--   3. 伤病/阵容由自建爬虫写入，阵容只保留每队最近 1 场（见 maintenance.sql）；
--   4. 后续要接小程序，所以不依赖任何平台专有类型。
--
-- 约定：
--   · 时间一律 timestamptz，写入时必须显式 +08:00（Vercel 进程是 UTC）；
--   · 金额一律 numeric(18,2)，不要 float；
--   · 号码用 smallint[]，同时保留上游原串，避免前导零/格式丢失；
--   · 所有表可幂等重写（自然键唯一约束），爬虫重跑不产生脏数据。
-- ============================================================================


-- ============================================================================
-- 一、彩票域
-- ============================================================================

-- 彩种字典。上游 gameNo 毫无规律（35 / 04 / 85 / 350133），代码里只用 game_key。
create table lottery_game (
  game_no        text primary key,
  game_key       text not null unique,
  name           text not null,
  -- 位置型：号码按位有意义（排列三/五、七星彩）；大乐透是集合
  is_positional  boolean not null default false,
  digit_count    smallint,
  main_count     smallint not null,
  main_max       smallint not null,
  extra_count    smallint not null default 0,
  extra_max      smallint,
  draw_weekdays  smallint[] not null default '{}'::smallint[],  -- ISO 1-7
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  constraint lottery_game_main_max_chk check (main_max between 1 and 99),
  constraint lottery_game_extra_chk    check (extra_count = 0 or extra_max is not null)
);

-- 开奖期。只追加，不覆盖历史。
create table lottery_draw (
  id             bigint generated always as identity primary key,
  game_no        text not null references lottery_game(game_no) on delete restrict,
  issue          text not null,              -- 期号字符串，如 '26280'
  issue_seq      bigint not null,            -- 数值化，供游标分页/范围查询
  draw_date      date not null,
  main_numbers   smallint[] not null,        -- 排列三 {8,6,4}；大乐透前区 {1,6,10,15,32}
  extra_numbers  smallint[] not null default '{}'::smallint[],  -- 大乐透后区
  numbers_text   text not null,              -- 上游原串，保留 '01 06 10' 形态
  sales_amount   numeric(18,2),              -- totalSaleAmount
  pool_balance   numeric(18,2),              -- poolBalance
  pool_balance_after numeric(18,2),          -- poolBalanceAfterdraw
  draw_at        timestamptz,
  sale_end_at    timestamptz,
  raw            jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint lottery_draw_key unique (game_no, issue),
  constraint lottery_draw_issue_seq_chk check (issue_seq > 0)
);

create index lottery_draw_seq_idx  on lottery_draw (game_no, issue_seq desc);
create index lottery_draw_date_idx on lottery_draw (game_no, draw_date desc);

-- 奖级明细。上游 prizeLevelList 的 prizeLevel 是中文名（一等奖 / 一等奖(追加) / 直选 / 组选3），
-- 天然可做稳定性键；sort 用于展示排序。
create table lottery_prize_level (
  draw_id      bigint not null references lottery_draw(id) on delete cascade,
  prize_key    text not null,             -- prizeLevel 原值
  sort_no      integer,
  stake_count  bigint,
  prize_amount numeric(18,2),             -- stakeAmountFormat，单注奖金
  total_amount numeric(18,2),             -- totalPrizeamount
  raw          jsonb not null default '{}'::jsonb,
  primary key (draw_id, prize_key)
);


-- ============================================================================
-- 二、足球域
-- ============================================================================

create table league (
  id         bigint generated always as identity primary key,
  name       text not null unique,        -- 上游只给 leagueAllName
  created_at timestamptz not null default now()
);

create table team (
  id           bigint generated always as identity primary key,
  sporttery_id bigint unique,             -- homeTeamId / awayTeamId
  name_abbr    text not null,
  name_full    text,
  league_id    bigint references league(id) on delete set null,
  -- AI 场馆解析结果：一次解析、永久复用（替代内存里 7 天过期的缓存）
  venue_city   text,
  venue_lat    numeric(9,6),
  venue_lon    numeric(9,6),
  venue_tz     text,
  venue_source text,                      -- 'llm' | 'manual'
  venue_resolved_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index team_name_idx on team (name_abbr);

-- 球队别名：体彩给"热刺"，第三方给"Tottenham Hotspur"，人工确认一次即可复用
create table team_alias (
  team_id bigint not null references team(id) on delete cascade,
  alias   text not null,
  source  text,
  primary key (team_id, alias)
);

create index team_alias_lookup_idx on team_alias (alias);

-- 竞彩赛事。只入库竞彩比赛，所以 sporttery_match_id 必填且唯一。
create table match (
  id               bigint generated always as identity primary key,
  sporttery_match_id bigint not null unique,
  business_date    date,                  -- 竞彩销售日，可能与自然日不同
  match_num_str    text,                  -- '周六001'
  kickoff_at       timestamptz not null,  -- business_date + matchTime，按 +08:00 解析
  league_id        bigint references league(id) on delete set null,
  league_name      text not null,         -- 快照，league 缺失时兜底
  home_team_id     bigint not null references team(id) on delete restrict,
  away_team_id     bigint not null references team(id) on delete restrict,
  home_name        text not null,         -- 快照，防止球队改名后历史错乱
  away_name        text not null,
  status           text not null default 'scheduled',
  sell_status      text not null default 'on_sale',
  -- 赛果。半场比分是"半全场"玩法的唯一来源，必须单列存。
  home_score       smallint,
  away_score       smallint,
  home_half_score  smallint,
  away_half_score  smallint,
  result_status    text,                  -- 'finished' | 'abandoned' | 'awarded'
  result_source    text,
  result_at        timestamptz,
  -- 半全场代码：h/d/a × h/d/a → 'hh' 'hd' … 'aa'，可直接分组统计
  htft text generated always as (
    case
      when home_half_score is null or away_half_score is null
        or home_score is null or away_score is null then null
      else
        (case when home_half_score > away_half_score then 'h'
              when home_half_score = away_half_score then 'd'
              else 'a' end)
        ||
        (case when home_score > away_score then 'h'
              when home_score = away_score then 'd'
              else 'a' end)
    end
  ) stored,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  raw              jsonb not null default '{}'::jsonb,
  updated_at       timestamptz not null default now(),
  constraint match_status_chk      check (status in ('scheduled','live','finished','cancelled','unknown')),
  constraint match_sell_status_chk check (sell_status in ('on_sale','closed')),
  constraint match_score_chk       check ((home_score is null or home_score >= 0)
                                       and (away_score is null or away_score >= 0)),
  constraint match_team_diff_chk   check (home_team_id <> away_team_id)
);

create index match_h2h_idx      on match (home_team_id, away_team_id, kickoff_at desc);
create index match_home_kick_idx on match (home_team_id, kickoff_at desc);
create index match_away_kick_idx on match (away_team_id, kickoff_at desc);
create index match_date_idx     on match (business_date, kickoff_at);
create index match_kickoff_idx  on match (kickoff_at desc);
create index match_seen_idx     on match (last_seen_at desc);

-- 赔率快照：一次内容变更一行，所有玩法打包在 jsonb。内容没变就整行不写。
create table match_odds_snapshot (
  id           bigint generated always as identity primary key,
  match_id     bigint not null references match(id) on delete cascade,
  odds         jsonb not null,            -- {had:{...},hhad:{...},ttg:{...},crs:{...},hafu:{...}}
  content_hash text not null,             -- sha256(规范化序列化)
  captured_at  timestamptz not null default now(),
  constraint match_odds_snapshot_key unique (match_id, content_hash)
);

create index odds_latest_idx    on match_odds_snapshot (match_id, captured_at desc);
create index odds_retention_idx on match_odds_snapshot (captured_at);

-- 球员。转会会改 team_id，所以不做强约束。
create table player (
  id          bigint generated always as identity primary key,
  team_id     bigint references team(id) on delete set null,
  name        text not null,
  position    text,
  shirt_no    smallint,
  birth_date  date,
  nationality text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index player_team_idx on player (team_id);

-- 伤病。ended_on 为空表示"当前未愈"，配合部分索引做热路径。
create table injury (
  id              bigint generated always as identity primary key,
  player_id       bigint not null references player(id) on delete cascade,
  team_id         bigint references team(id) on delete set null,
  status          text not null,          -- 'out' | 'doubtful' | 'returned'
  injury_type     text,
  body_part       text,
  started_on      date,
  expected_return date,
  ended_on        date,
  source          text not null,
  source_ref      text,
  reported_at     timestamptz not null default now(),
  raw             jsonb not null default '{}'::jsonb,
  constraint injury_status_chk check (status in ('out','doubtful','returned')),
  constraint injury_ref_key unique (source, source_ref)
);

create index injury_active_idx on injury (team_id, started_on desc) where ended_on is null;
create index injury_player_idx on injury (player_id, started_on desc);

-- 阵容：表头 + 明细。confirmed=true 才代表官方名单（赛前 1h），否则是媒体预测。
create table match_lineup (
  match_id    bigint not null references match(id) on delete cascade,
  team_id     bigint not null references team(id) on delete cascade,
  formation   text,
  coach       text,
  confirmed   boolean not null default false,
  source      text not null,
  captured_at timestamptz not null default now(),
  primary key (match_id, team_id)
);

create table match_lineup_player (
  match_id  bigint not null,
  team_id   bigint not null,
  player_id bigint not null references player(id) on delete cascade,
  is_starter boolean not null default false,
  position  text,
  shirt_no  smallint,
  minutes_played smallint,
  primary key (match_id, team_id, player_id),
  foreign key (match_id, team_id)
    references match_lineup (match_id, team_id) on delete cascade
);

-- 跨源实体映射：第三方 team/player/match id → 本地 id
create table external_ref (
  entity      text not null,              -- 'team' | 'player' | 'match'
  source      text not null,              -- 'sporttery' | 'api_football' | 'football_data' | 'manual'
  external_id text not null,
  local_id    bigint not null,
  confidence  numeric(3,2) not null default 1.0,
  created_at  timestamptz not null default now(),
  primary key (source, entity, external_id),
  constraint external_ref_entity_chk     check (entity in ('team','player','match')),
  constraint external_ref_confidence_chk check (confidence > 0 and confidence <= 1)
);

create index external_ref_local_idx on external_ref (entity, local_id);


-- ============================================================================
-- 三、可观测性
-- ============================================================================

-- 每批抓取一行。API 用它回答"当前数据是多少分钟前的"。
create table crawl_run (
  id            bigint generated always as identity primary key,
  source        text not null,            -- 'sporttery.matches' / 'sporttery.result' / 'sporttery.history:pl5' …
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running',
  http_status   integer,
  duration_ms   integer,
  item_count    integer,
  changed_count integer,                  -- 本轮真正写库的条数，可看出上游节奏
  error         text,
  meta          jsonb not null default '{}'::jsonb,
  constraint crawl_run_status_chk check (status in ('running','ok','failed','skipped'))
);

create index crawl_run_idx on crawl_run (source, started_at desc);


-- ============================================================================
-- 四、视图
-- ============================================================================

-- 球队视角：把主客两个方向拉平，避免每个查询都写 or。
-- 客队视角的 htft 需要用 translate 翻转 h/a（d 不变）。
create view match_side as
select
  m.id                  as match_id,
  m.home_team_id        as team_id,
  'home'::text          as side,
  m.away_team_id        as opponent_id,
  m.home_score          as goals_for,
  m.away_score          as goals_against,
  m.home_half_score     as goals_for_ht,
  m.away_half_score     as goals_against_ht,
  m.htft                as htft,
  m.kickoff_at          as kickoff_at,
  m.league_name         as league_name,
  m.status              as status
from match m
where m.home_team_id is not null
union all
select
  m.id,
  m.away_team_id,
  'away'::text,
  m.home_team_id,
  m.away_score,
  m.home_score,
  m.away_half_score,
  m.home_half_score,
  translate(m.htft, 'ha', 'ah'),
  m.kickoff_at,
  m.league_name,
  m.status
from match m
where m.away_team_id is not null;

-- 每场最新赔率
create view match_odds_latest as
select distinct on (match_id)
  match_id, odds, captured_at
from match_odds_snapshot
order by match_id, captured_at desc;


-- ============================================================================
-- 五、权限（部署时按需执行，见 db/README.md）
-- ============================================================================
-- create role ticai_api login password '...';
-- grant select on all tables in schema public to ticai_api;
-- grant update (venue_city, venue_lat, venue_lon, venue_tz, venue_source, venue_resolved_at)
--   on team to ticai_api;
--
-- create role ticai_crawler login password '...';
-- grant select, insert, update, delete on all tables in schema public to ticai_crawler;
-- grant usage, select on all sequences in schema public to ticai_crawler;
