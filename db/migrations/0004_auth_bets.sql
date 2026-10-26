-- ============================================================================
-- 0004：可选登录 + 投注记录
--
-- 登录是「可选」能力：不登录也能正常看赛事/开奖，登录后才能保存投注单、
-- 查看「我的投注」并自动判中奖。
--
-- 认证方案：
--   - 邮箱 + 密码（scrypt，库里只存 salt:hash）；
--   - 邮箱验证码（6 位，10 分钟有效，最多试 5 次，用于注册验证与免密登录）；
--   - 会话用不透明随机 token（库里只存 sha256），前端放 Authorization: Bearer。
--     不引 JWT：没有签名密钥要轮换，token 可以直接吊销。
-- ============================================================================

create table if not exists app_user (
  id            bigint generated always as identity primary key,
  email         text not null,                       -- 统一小写存储
  password_hash text not null,                       -- scrypt: salt:hash（hex）
  status        text not null default 'active',
  created_at    timestamptz not null default now(),
  last_login_at timestamptz,
  constraint app_user_status_chk check (status in ('active', 'disabled')),
  constraint app_user_email_chk  check (position('@' in email) > 1)
);

create unique index if not exists app_user_email_key on app_user (lower(email));

-- 验证码。存 sha256(code + ':' + email + ':' + purpose)，不存明文。
create table if not exists email_code (
  id          bigint generated always as identity primary key,
  email       text not null,
  purpose     text not null,
  code_hash   text not null,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  attempts    smallint not null default 0,
  created_at  timestamptz not null default now(),
  constraint email_code_purpose_chk check (purpose in ('register', 'login'))
);

create index if not exists email_code_lookup_idx on email_code (lower(email), purpose, created_at desc);

create table if not exists user_session (
  id           bigint generated always as identity primary key,
  user_id      bigint not null references app_user(id) on delete cascade,
  token_hash   text not null unique,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at   timestamptz not null
);

create index if not exists user_session_user_idx on user_session (user_id, expires_at desc);

-- 一份投注单（方案）。legs 在 bet_leg，每个「场次 × 选项」一行；同一场选多个选项就是复式。
create table if not exists bet (
  id          bigint generated always as identity primary key,
  user_id     bigint not null references app_user(id) on delete cascade,
  title       text not null default '',
  pass_types  text[] not null default '{}',          -- '2串1' / '3串1' …
  multiple    smallint not null default 1,
  units       integer not null default 0,            -- 注数
  amount      numeric(12, 2) not null default 0,     -- 投注金额（元）
  max_bonus   numeric(12, 2) not null default 0,     -- 理论最高奖金（元）
  note        text,
  placed_at   timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  constraint bet_multiple_chk check (multiple between 1 and 50),
  constraint bet_amount_chk   check (amount >= 0)
);

create index if not exists bet_user_idx on bet (user_id, placed_at desc);

create table if not exists bet_leg (
  id                  bigint generated always as identity primary key,
  bet_id              bigint not null references bet(id) on delete cascade,
  sporttery_match_id  bigint not null,
  match_num_str       text,
  league_name         text,
  home_name           text,
  away_name           text,
  kickoff_at          timestamptz,
  pool                text not null,                 -- had | hhad | ttg | crs | hafu
  option_key          text not null,                 -- h / rq-h / s3 / s02s01 / hh
  option_label        text,
  odds                numeric(8, 2) not null,
  goal_line           smallint,
  constraint bet_leg_pool_chk check (pool in ('had', 'hhad', 'ttg', 'crs', 'hafu')),
  constraint bet_leg_odds_chk check (odds >= 1)
);

create index if not exists bet_leg_bet_idx   on bet_leg (bet_id);
create index if not exists bet_leg_match_idx on bet_leg (sporttery_match_id);
