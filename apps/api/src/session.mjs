import { createSessionToken, hashToken, readToken } from './auth.mjs'
import { query } from './db.mjs'
import { HttpError } from './lib.mjs'

/**
 * 会话：不透明 token，库里只存 sha256。
 *
 * 之所以不用 JWT：
 *   - 没有签名密钥要管理/轮换；
 *   - 退出登录、改密码可以直接吊销；
 *   - 前端只存一个字符串，放在 Authorization 头里，跨域不用折腾 Cookie 的 SameSite。
 */

const SESSION_SQL = `
  select u.id, u.email, u.display_name, u.avatar_url, u.created_at, s.id as session_id, s.expires_at
  from user_session s
  join app_user u on u.id = s.user_id
  where s.token_hash = $1
    and s.expires_at > now()
    and u.status = 'active'
  limit 1
`

export function toPublicUser(row) {
  return {
    id: String(row.id),
    // 微信首次登录的账号可以没有邮箱
    email: row.email ?? null,
    displayName: row.display_name ?? null,
    avatarUrl: row.avatar_url ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  }
}

export async function createSession(config, userId, { userAgent = '', req } = {}) {
  const token = createSessionToken()
  const days = config.auth.sessionDays

  await query(config, `
    insert into user_session (user_id, token_hash, user_agent, expires_at)
    values ($1, $2, $3, now() + ($4::int * interval '1 day'))
  `, [userId, hashToken(token), String(userAgent || '').slice(0, 200) || null, days])

  // 顺手清理该用户已过期的会话，避免表无限增长
  await query(config, 'delete from user_session where user_id = $1 and expires_at <= now()', [userId]).catch(() => {})

  return { token, expiresInDays: days, expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() }
}

/** 只读解析：没有/失效都返回 null。 */
export async function resolveSession(config, req) {
  const token = readToken(req)
  if (!token) {
    return null
  }

  const { rows } = await query(config, SESSION_SQL, [hashToken(token)])
  const row = rows[0]
  if (!row) {
    return null
  }

  // 每小时最多回写一次 last_used_at，别让每个请求都多一次写
  query(
    config,
    "update user_session set last_used_at = now() where id = $1 and last_used_at < now() - interval '1 hour'",
    [row.session_id],
  ).catch(() => {})

  return { user: toPublicUser(row), sessionId: row.session_id }
}

/** 必须登录的接口用这个：拿不到会话直接 401。 */
export async function requireSession(config, req) {
  const session = await resolveSession(config, req)
  if (!session) {
    throw new HttpError(401, '请先登录')
  }
  return session
}

export async function destroySession(config, req) {
  const token = readToken(req)
  if (!token) {
    return false
  }
  const { rowCount } = await query(config, 'delete from user_session where token_hash = $1', [hashToken(token)])
  return (rowCount ?? 0) > 0
}

/**
 * 一次性登录票据。
 *
 * OAuth 回调是浏览器跳转，不能把会话 token 拼进 URL（会进历史记录/代理日志），
 * 所以回调只落一张短命票据，前端再拿它换正式会话；换完立即作废。
 */
export async function createAuthTicket(config, userId, { purpose = 'wechat_login' } = {}) {
  const ticket = createSessionToken()
  const seconds = config.auth.ticketSeconds

  await query(
    config,
    `insert into auth_ticket (token_hash, user_id, purpose, expires_at)
     values ($1, $2, $3, now() + ($4::int * interval '1 second'))`,
    [hashToken(ticket), userId, purpose, seconds],
  )

  // 过期的票据留 1 小时就清掉，避免表里堆垃圾
  query(config, "delete from auth_ticket where expires_at < now() - interval '1 hour'").catch(() => {})

  return { ticket, expiresInSeconds: seconds }
}

export async function consumeAuthTicket(config, rawTicket) {
  const ticket = String(rawTicket ?? '').trim()
  if (!ticket) {
    throw new HttpError(400, '缺少登录票据')
  }

  const { rows } = await query(
    config,
    `update auth_ticket set consumed_at = now()
     where token_hash = $1 and consumed_at is null and expires_at > now()
     returning user_id`,
    [hashToken(ticket)],
  )

  if (!rows[0]) {
    throw new HttpError(400, '登录票据无效或已过期，请重新登录')
  }
  return rows[0].user_id
}
