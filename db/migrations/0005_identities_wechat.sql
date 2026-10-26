-- ============================================================================
-- 0005：第三方身份（先接微信，架构上不写死）
--
-- 目标：把「账号」和「登录方式」拆开。
--   账号           app_user        一个自然人在本站的记录（邮箱可空）
--   身份           user_identity   一种登录方式绑定到账号：邮箱 / 微信
--
-- 为什么现在就拆：
--   - 微信扫码登录（开放平台网站应用）拿不到邮箱，账号必须允许没有邮箱；
--   - 同一个人可能先邮箱注册、后绑微信，绑定时是「给已有账号加一条身份」，
--     不是新建账号，所以身份必须是独立表；
--   - 以后接公众号网页授权 / 小程序 / Apple，只是再加一个 channel，
--     app_user、会话、投注都不用动。
--
-- 票据：微信回调发生在浏览器跳转里，不能把会话 token 放 URL，
--   所以回调只写一张 2 分钟、一次性消费的 auth_ticket，前端拿它换正式会话。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. app_user 允许没有邮箱（微信首次登录直接建号），并补展示字段
-- ---------------------------------------------------------------------------
alter table app_user alter column email drop not null;

alter table app_user add column if not exists display_name text;
alter table app_user add column if not exists avatar_url   text;

drop index if exists app_user_email_key;
create unique index if not exists app_user_email_key
  on app_user (lower(email)) where email is not null;

alter table app_user drop constraint if exists app_user_email_chk;
alter table app_user add constraint app_user_email_chk
  check (email is null or position('@' in email) > 1);

-- ---------------------------------------------------------------------------
-- 2. 身份表
-- ---------------------------------------------------------------------------
create table if not exists user_identity (
  id             bigint generated always as identity primary key,
  user_id        bigint not null references app_user(id) on delete cascade,
  provider       text not null,          -- 'email' | 'wechat'
  channel        text not null,          -- 'email' | 'wechat_web' | 'wechat_mp'
  provider_uid   text not null,          -- 邮箱（小写）或微信 openid
  union_id       text,                   -- 微信 unionid（同一开放平台下唯一）
  nickname       text,
  avatar_url     text,
  raw            jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz,
  constraint user_identity_provider_chk check (provider in ('email', 'wechat')),
  constraint user_identity_channel_chk  check (channel in ('email', 'wechat_web', 'wechat_mp'))
);

-- 一个 openid / 邮箱只能属于一个账号
create unique index if not exists user_identity_uid_key
  on user_identity (provider, provider_uid);

-- 同一账号在同一渠道只绑一个身份（重复绑定按幂等处理）
create unique index if not exists user_identity_user_channel_key
  on user_identity (user_id, provider, channel);

create index if not exists user_identity_union_idx
  on user_identity (union_id) where union_id is not null;

-- ---------------------------------------------------------------------------
-- 3. 一次性登录票据（微信回调 → 前端换会话）
-- ---------------------------------------------------------------------------
create table if not exists auth_ticket (
  id           bigint generated always as identity primary key,
  token_hash   text not null unique,     -- sha256(ticket)，不存明文
  user_id      bigint not null references app_user(id) on delete cascade,
  purpose      text not null default 'wechat_login',
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists auth_ticket_user_idx on auth_ticket (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. 回填：已有邮箱账号补一条 email 身份
-- ---------------------------------------------------------------------------
insert into user_identity (user_id, provider, channel, provider_uid, nickname, created_at)
select id, 'email', 'email', lower(email), split_part(email, '@', 1), created_at
from app_user
where email is not null
on conflict do nothing;
