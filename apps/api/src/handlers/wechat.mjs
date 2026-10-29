import { query, withTransaction } from '../db.mjs'
import { HttpError, readJsonBody, sendData } from '../lib.mjs'
import { consumeAuthTicket, createAuthTicket, createSession, requireSession, toPublicUser } from '../session.mjs'
import { WECHAT_CHANNELS, createWechatService } from '../wechat.mjs'

/**
 * 微信绑定 / 登录。
 *
 * 流程（与具体渠道无关）：
 *   1. 前端拿 `authorizeUrl` 跳微信；
 *   2. 微信 302 回 `/api/auth/wechat/callback?code&state`；
 *   3. 服务端校验 state → code 换身份 → 找账号 / 建账号 / 绑到当前账号；
 *   4. 落一张 2 分钟的一次性票据，302 回前端 `/auth/wechat?ticket=...`；
 *   5. 前端用票据换正式会话。
 *
 * 为什么回调不直接发 token：URL 会进浏览器历史、Referer 与反代日志。
 */

const USER_COLUMNS =
  'id, email, password_hash is not null as has_password, display_name, avatar_url, created_at'

export function createWechatHandlers(config) {
  const wechat = createWechatService(config)

  function webRedirect(query) {
    const params = new URLSearchParams(query)
    return `${config.auth.webBaseUrl}/auth/wechat?${params.toString()}`
  }

  async function findUserById(userId) {
    const { rows } = await query(config, `select ${USER_COLUMNS} from app_user where id = $1 limit 1`, [userId])
    return rows[0] ?? null
  }

  async function findWechatUser(identity) {
    if (identity.unionid) {
      const { rows } = await query(
        config,
        `select u.${USER_COLUMNS.split(', ').join(', u.')}
         from user_identity i join app_user u on u.id = i.user_id
         where i.provider = 'wechat' and i.union_id = $1
         limit 1`,
        [identity.unionid],
      )
      if (rows[0]) {
        return rows[0]
      }
    }

    const { rows } = await query(
      config,
      `select u.${USER_COLUMNS.split(', ').join(', u.')}
       from user_identity i join app_user u on u.id = i.user_id
       where i.provider = 'wechat' and i.provider_uid = $1
       limit 1`,
      [identity.openid],
    )
    return rows[0] ?? null
  }

  async function touchIdentity(identity, channel) {
    await query(
      config,
      `update user_identity set
         last_login_at = now(),
         union_id  = coalesce($3, union_id),
         nickname  = coalesce(nullif($4, ''), nickname),
         avatar_url = coalesce(nullif($5, ''), avatar_url),
         raw = $6
       where provider = 'wechat' and provider_uid = $1 and channel = $2`,
      [identity.openid, channel, identity.unionid, identity.nickname, identity.avatarUrl, identity.raw],
    ).catch(() => {})
  }

  /** 微信首次登录：没有邮箱，直接建账号 + 身份。 */
  async function createWechatUser(identity, channel) {
    try {
      return await withTransaction(config, async (client) => {
        const { rows } = await client.query(
          `insert into app_user (email, display_name, avatar_url)
           values (null, $1, $2)
           returning ${USER_COLUMNS}`,
          [identity.nickname || '微信用户', identity.avatarUrl || null],
        )
        const user = rows[0]

        await client.query(
          `insert into user_identity (user_id, provider, channel, provider_uid, union_id, nickname, avatar_url, raw, last_login_at)
           values ($1, 'wechat', $2, $3, $4, $5, $6, $7, now())`,
          [
            user.id,
            channel,
            identity.openid,
            identity.unionid,
            identity.nickname || null,
            identity.avatarUrl || null,
            identity.raw ?? {},
          ],
        )

        return user
      })
    } catch (error) {
      // 并发回调可能同时建号：唯一索引兜底后重新取一次
      if (String(error?.code) === '23505') {
        const existing = await findWechatUser(identity)
        if (existing) {
          return existing
        }
      }
      throw error
    }
  }

  async function loginWithIdentity(identity, channel) {
    const existing = await findWechatUser(identity)
    if (existing) {
      await touchIdentity(identity, channel)
      return existing
    }
    return createWechatUser(identity, channel)
  }

  async function bindToUser(identity, channel, userId) {
    const { rows: owned } = await query(
      config,
      `select provider_uid from user_identity
       where provider = 'wechat' and provider_uid = $1 limit 1`,
      [identity.openid],
    )
    if (owned[0] && String(owned[0].provider_uid) === identity.openid) {
      const { rows } = await query(
        config,
        `select user_id from user_identity where provider = 'wechat' and provider_uid = $1 limit 1`,
        [identity.openid],
      )
      if (rows[0] && String(rows[0].user_id) !== String(userId)) {
        throw new HttpError(409, '该微信已绑定其他账号，请先在原账号解绑')
      }
    }

    const { rows: mine } = await query(
      config,
      `select provider_uid from user_identity
       where user_id = $1 and provider = 'wechat' and channel = $2 limit 1`,
      [userId, channel],
    )
    if (mine[0] && mine[0].provider_uid !== identity.openid) {
      throw new HttpError(409, '当前账号已绑定另一个微信，请先解绑')
    }

    await query(
      config,
      `insert into user_identity (user_id, provider, channel, provider_uid, union_id, nickname, avatar_url, raw, last_login_at)
       values ($1, 'wechat', $2, $3, $4, $5, $6, $7, now())
       on conflict (provider, provider_uid) do update set
         union_id   = coalesce(excluded.union_id, user_identity.union_id),
         nickname   = coalesce(nullif(excluded.nickname, ''), user_identity.nickname),
         avatar_url = coalesce(nullif(excluded.avatar_url, ''), user_identity.avatar_url),
         raw        = excluded.raw,
         last_login_at = now()`,
      [
        userId,
        channel,
        identity.openid,
        identity.unionid,
        identity.nickname || null,
        identity.avatarUrl || null,
        identity.raw ?? {},
      ],
    )

    // 账号资料为空时用微信资料补上
    await query(
      config,
      `update app_user set
         display_name = coalesce(nullif(display_name, ''), $2),
         avatar_url   = coalesce(nullif(avatar_url, ''), $3),
         last_login_at = now()
       where id = $1`,
      [userId, identity.nickname || null, identity.avatarUrl || null],
    )

    return findUserById(userId)
  }

  /** 回调核心：code → 身份 → 账号 → 票据 → 前端地址。 */
  async function completeAuthorization({ code, state }) {
    const payload = wechat.verifyState(state)
    const identity = await wechat.exchangeCode({ code, channel: payload.channel })

    const user =
      payload.mode === 'bind'
        ? await bindToUser(identity, payload.channel, Number(payload.userId))
        : await loginWithIdentity(identity, payload.channel)

    if (!user) {
      throw new HttpError(500, '微信登录失败：账号状态异常')
    }

    const { ticket } = await createAuthTicket(config, user.id)
    return webRedirect({ ticket, mode: payload.mode })
  }

  async function getConfig(ctx) {
    sendData(ctx.res, wechat.describe())
  }

  /** 返回授权地址给前端跳转；弹窗/新标签页都可以。 */
  async function start(ctx) {
    const mode = ctx.url.searchParams.get('mode') === 'bind' ? 'bind' : 'login'
    const rawChannel = ctx.url.searchParams.get('channel')
    const channel = rawChannel === 'mp' ? WECHAT_CHANNELS.mp : WECHAT_CHANNELS.web

    let userId = null
    if (mode === 'bind') {
      const session = await requireSession(config, ctx.req)
      userId = session.user.id
    }

    const state = wechat.signState({ mode, channel, userId })
    const authorizeUrl = wechat.buildAuthorizeUrl({ mode, channel, state })

    sendData(ctx.res, { authorizeUrl, mode, channel })
  }

  async function callback(ctx) {
    const code = ctx.url.searchParams.get('code') ?? ''
    const state = ctx.url.searchParams.get('state') ?? ''

    if (!code) {
      const reason = ctx.url.searchParams.get('error_description') || '微信授权被取消'
      ctx.res.writeHead(302, { location: webRedirect({ error: reason }) })
      ctx.res.end()
      return
    }

    let location
    try {
      location = await completeAuthorization({ code, state })
    } catch (error) {
      const message = error instanceof HttpError ? error.message : '微信登录失败，请稍后重试'
      if (!(error instanceof HttpError)) {
        console.error('[wechat] 回调异常：', error)
      }
      location = webRedirect({ error: message })
    }

    ctx.res.writeHead(302, { location })
    ctx.res.end()
  }

  /** 用一次性票据换正式会话。 */
  async function exchange(ctx) {
    const body = await readJsonBody(ctx.req)
    const userId = await consumeAuthTicket(config, body?.ticket)
    const user = await findUserById(userId)
    if (!user) {
      throw new HttpError(400, '账号不存在或已注销')
    }

    await query(config, 'update app_user set last_login_at = now() where id = $1', [user.id])

    const session = await createSession(config, user.id, {
      userAgent: ctx.req.headers?.['user-agent'] ?? '',
      // 微信登录能证明微信账号归属，但证明不了邮箱/密码：改密码时仍要验当前密码
      verifiedBy: 'wechat',
    })

    sendData(ctx.res, {
      token: session.token,
      expiresAt: session.expiresAt,
      expiresInDays: session.expiresInDays,
      user: toPublicUser(user),
    })
  }

  /** 账号页：列出当前账号的登录方式（不发 openid 明文）。 */
  async function identities(ctx) {
    const session = await requireSession(config, ctx.req)
    const { rows } = await query(
      config,
      `select provider, channel, provider_uid, nickname, avatar_url, created_at, last_login_at
       from user_identity where user_id = $1 order by created_at`,
      [session.user.id],
    )

    sendData(ctx.res, {
      items: rows.map((row) => ({
        provider: row.provider,
        channel: row.channel,
        nickname: row.nickname ?? '',
        avatarUrl: row.avatar_url ?? null,
        uidHint: row.provider === 'email' ? '' : `…${String(row.provider_uid).slice(-4)}`,
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
      })),
    })
  }

  /** 解绑：至少保留一种登录方式。 */
  async function unbind(ctx) {
    const session = await requireSession(config, ctx.req)
    const provider = String(ctx.params.provider ?? '')

    const { rows } = await query(
      config,
      'select count(*)::int as total from user_identity where user_id = $1',
      [session.user.id],
    )
    if (rows[0].total <= 1) {
      throw new HttpError(400, '至少保留一种登录方式，不能解绑最后一个')
    }

    const { rowCount } = await query(
      config,
      'delete from user_identity where user_id = $1 and provider = $2',
      [session.user.id, provider],
    )
    if ((rowCount ?? 0) === 0) {
      throw new HttpError(404, '没有找到该登录方式')
    }

    sendData(ctx.res, { ok: true })
  }

  return { getConfig, start, callback, exchange, identities, unbind }
}
