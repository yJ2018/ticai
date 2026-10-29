-- ============================================================================
-- 0008：验证码登录即注册 + 登录后设置密码
--
-- 产品变化：验证码登录不再要求邮箱已注册。邮箱验证码本身就证明了邮箱归属，
-- 所以未注册邮箱直接建一个「无密码」账号；用户登录后可以设置密码，下次改用
-- 邮箱 + 密码登录（微信建的账号要先绑定邮箱，才有登录标识）。
--
-- 这次迁移只补三样东西，不动既有数据：
--   1. email_code.purpose 增加 'bind' —— 给「未绑定邮箱的账号绑定邮箱」发码；
--   2. user_session.verified_by —— 会话是怎么建立的。验证码登录的会话可以直接
--      覆盖密码（忘记密码的自助路径），密码 / 微信登录的会话必须再验一次当前密码；
--   3. app_user.password_updated_at —— 密码最后设置时间，账号页展示用。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 密码更新时间
-- ---------------------------------------------------------------------------
alter table app_user add column if not exists password_updated_at timestamptz;

-- 已有的密码账号视为「上次改密时间未知」，不猜测回填；密码只存哈希，时间不涉及安全

-- ---------------------------------------------------------------------------
-- 2. 会话建立方式
--
-- 默认 'password' 是保守选择：历史会话一律按「必须验当前密码」处理。
-- ---------------------------------------------------------------------------
alter table user_session add column if not exists verified_by text not null default 'password';

alter table user_session drop constraint if exists user_session_verified_by_chk;
alter table user_session add constraint user_session_verified_by_chk
  check (verified_by in ('password', 'code', 'wechat'));

-- ---------------------------------------------------------------------------
-- 3. 验证码用途增加 bind
--
-- register —— 注册（邮箱 + 密码 + 验证码）
-- login    —— 免密登录；邮箱未注册时顺手建号
-- bind     —— 已登录账号绑定邮箱（当前账号还没有邮箱）
-- ---------------------------------------------------------------------------
alter table email_code drop constraint if exists email_code_purpose_chk;
alter table email_code add constraint email_code_purpose_chk
  check (purpose in ('register', 'login', 'bind'));
