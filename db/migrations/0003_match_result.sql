-- ============================================================================
-- 0003：竞彩足球「赛果开奖」
--
-- 数据源：体彩官网竞彩赛果开奖页（/jc/zqsgkj/）背后的接口
--   GET https://webapi.sporttery.cn/gateway/uniform/football/getUniformMatchResultV1.qry
--       ?matchBeginDate=YYYY-MM-DD&matchEndDate=YYYY-MM-DD&pageSize=100&pageNo=1
--
-- 设计要点：
--   1. 以 sporttery_match_id 为主键：一场比赛只留最新一次开奖，天然幂等；
--      同时回填 match_id，把「开奖」和「当时在售的那场比赛」接起来。
--   2. 上游只直接给胜平负（winFlag）和半场/全场比分；其余玩法全部由比分推导，
--      推导在爬虫里做（normalize.mjs，纯函数可单测），这里只存结果列。
--      之所以不用 generated column / SQL 函数：推导规则要跟前端玩法 key 严格一致，
--      放在一处（JS）比在 SQL 里再写一份更不容易漂。
--   3. 有了这张表，伤停爬取不再需要逐场抓「近期赛果」，
--      details 每条链路的请求数从 2 次降到 1 次。
-- ============================================================================

create table if not exists match_result (
  sporttery_match_id bigint primary key,
  -- 关联本地在售比赛；老比赛/未入库的比赛允许为空
  match_id            bigint references match(id) on delete set null,
  match_num_str       text,                 -- '周日006'
  match_date          date,                 -- 真实比赛日（北京时间）
  league_id           bigint,
  league_name         text,
  home_name           text not null,
  away_name           text not null,
  home_team_id        bigint,               -- 体彩球队 id（与 team.sporttery_id 同源）
  away_team_id        bigint,
  -- 比分：上游给 '1:0' 形态，拆成两列
  half_home           smallint,
  half_away           smallint,
  full_home           smallint,
  full_away           smallint,
  -- 让球数（主队视角，'-1' 表示主队让一球）
  goal_line           smallint,
  -- 各玩法开奖结果，key 与前端 optionKey 对齐
  had_result          char(1),              -- h | d | a
  hhad_result         char(1),              -- h | d | a（已加让球）
  ttg_result          smallint,             -- 0..7（7 表示 7+）
  crs_result          text,                 -- 's02s01' / 's1sh' …
  hafu_result         text,                 -- 'hh' | 'hd' … 'aa'
  win_flag            text,                 -- 上游原始 winFlag（H/D/A/空）
  pool_status         text,                 -- Payout / Close / 空
  result_status       text,                 -- 上游 matchResultStatus
  -- 有全场比分即视为可结算；取消/无效场次由 settlement 按规则退款
  settled             boolean not null default false,
  settled_at          timestamptz,
  raw                 jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint match_result_had_chk  check (had_result  is null or had_result  in ('h','d','a')),
  constraint match_result_hhad_chk check (hhad_result is null or hhad_result in ('h','d','a')),
  constraint match_result_ttg_chk  check (ttg_result  is null or (ttg_result >= 0 and ttg_result <= 7))
);

create index if not exists match_result_match_idx    on match_result (match_id);
create index if not exists match_result_date_idx     on match_result (match_date desc);
create index if not exists match_result_settled_idx  on match_result (settled, match_date desc);
