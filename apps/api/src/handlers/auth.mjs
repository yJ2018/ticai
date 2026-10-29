import {
  assertPasswordStrength,
  createCode,
  hashCode,
  normalizeEmail,
  safeEqualHex,
  verifyPassword,
  hashPassword,
} from '../auth.mjs'
import { query, withTransaction } from '../db.mjs'
import {
  HttpError,
  assertSecureForAuth,
  clientIpFor,
  createRateLimiter,
  readJsonBody,
  sendData,
} from '../lib.mjs'
import { createMailer } from '../mail.mjs'
import {
  createSession,
  destroyOtherSessions,
  destroySession,
  requireSession,
  toPublicUser,
} from '../session.mjs'

/**
 * 可选登录：邮箱 + 密码 / 邮箱验证码。
 *
 * 验证码有三个用途：
 *   register —— 注册时验证邮箱归属（账号直接带密码）；
 *   login    —— 免密登录；邮箱还没注册就顺手建一个「无密码」账号，
 *               登录后在账号页设置密码，下次就可以用密码登录；
 *   bind     —— 已登录账号绑定邮箱（微信建的账号靠它拿到登录标识）。
 *
 * 密码设置（`setPassword`）的授权规则，按账号状态分三种：
 *   - 还没有密码：任何有效会话都可以设置（账号控制权已经证明）；
 *   - 有密码 + 会话是验证码登录的：可以直接覆盖（这就是「忘记密码」的路径）；
 *   - 有密码 + 其他会话：必须给当前密码，或再收一次验证码。
 * 改完密码会把该账号其他设备的会话吊销，只留当前这枚。
 *
 * 防滥用：同邮箱 60 秒冷却 + 每小时 6 次；同 IP 每小时 20 次；
 * 验证码 10 分钟过期、最多试 5 次，用完即作废。
 *
 * 密码永远不会落库或落日志：请求体只在内存里过一遍 scrypt，库里存 `scrypt$salt$hash`，
 * 请求日志只记 method / path / status。传输安全交给 HTTPS（见 assertSecureForAuth）。
 */

const CODE_PURPOSE = new Set(['register', 'login', 'bind'])

/** 公开用户字段 + 密码是否存在（账号页据此决定显示「设置」还是「修改」） */
const USER_COLUMNS =
  'id, email, password_hash, password_hash is not null as has_password, display_name, avatar_url, created_at'

export function createAuthHandlers(config) {
  const mailer = createMailer(config)
  const ipLimiter = createRateLimiter({
    limit: config.auth.codePerIpPerHour,
    windowMs: 3_600_000,
    maxKeys: 2_000,
  })

  // 密码登录/注册/改密的暴力破解防护：同一 IP、同一邮箱分别限速
  const loginIpLimiter = createRateLimiter({
    limit: config.auth.loginPerMinutePerIp,
    windowMs: 60_000,
    maxKeys: 5_000,
  })
  const loginEmailLimiter = createRateLimiter({
    limit: config.auth.loginPerMinutePerEmail,
    windowMs: 60_000,
    maxKeys: 5_000,
  })
  const registerIpLimiter = createRateLimiter({
    limit: config.auth.registerPerHourPerIp,
    windowMs: 3_600_000,
    maxKeys: 5_000,
  })

  // 邮箱不存在时也跑一次 scrypt，避免通过响应时间枚举哪些邮箱注册过
  let dummyHashPromise = null
  function getDummyHash() {
    dummyHashPromise ??= hashPassword('ticai-dummy-password-for-timing')
    return dummyHashPromise
  }

  async function findUser(email) {
    const { rows } = await query(
      config,
      `select ${USER_COLUMNS} from app_user where lower(email) = $1 limit 1`,
      [email],
    )
    return rows[0] ?? null
  }

  async function findUserById(userId) {
    const { rows } = await query(config, `select ${USER_COLUMNS} from app_user where id = $1 limit 1`, [
      userId,
    ])
    return rows[0] ?? null
  }

  /**
   * 验证码登录遇到没注册过的邮箱：建一个无密码账号。
   *
   * 能走到这里说明刚才那条验证码已经验证过（邮箱归属已证明），所以不需要密码；
   * 邮箱身份一并落库，账号页的「登录方式」列表才和密码注册的账号长得一样。
   */
  async function createEmailUser(email) {
    const displayName = email.split('@')[0]
    try {
      return await withTransaction(config, async (client) => {
        const { rows } = await client.query(
          `insert into app_user (email, display_name) values ($1, $2) returning ${USER_COLUMNS}`,
          [email, displayName],
        )
        const created = rows[0]

        await client.query(
          `insert into user_identity (user_id, provider, channel, provider_uid, nickname, last_login_at)
           values ($1, 'email', 'email', $2, $3, now())
           on conflict do nothing`,
          [created.id, email, created.display_name],
        )

        return created
      })
    } catch (error) {
      // 并发登录可能同时建号：唯一索引兜底后重新取一次
      if (String(error?.code) === '23505') {
        const existing = await findUser(email)
        if (existing) {
          return existing
        }
      }
      throw error
    }
  }

  async function issueCode(ctx) {
    assertSecureForAuth(ctx.req, { allowInsecure: config.auth.allowInsecure })

    const body = await readJsonBody(ctx.req)
    const email = normalizeEmail(body.email)
    const purpose = CODE_PURPOSE.has(body.purpose) ? body.purpose : 'login'

    ipLimiter(clientIpFor(ctx.req, { trustProxy: true }))

    const existing = await findUser(email)
    if (purpose === 'register' && existing) {
      throw new HttpError(409, '该邮箱已注册，请直接登录')
    }
    // purpose === 'login' 故意不要求邮箱已注册：验证码本身就证明邮箱归属，
    // 登录时会自动建号（见 createEmailUser）。
    if (purpose === 'bind') {
      const session = await requireSession(config, ctx.req)
      if (session.user.email) {
        throw new HttpError(409, '当前账号已绑定邮箱，暂不支持更换')
      }
      if (existing) {
        throw new HttpError(409, '该邮箱已被其他账号使用，请换一个')
      }
    }

    const { rows: recent } = await query(
      config,
      `select extract(epoch from (now() - created_at))::int as age_seconds
       from email_code
       where lower(email) = $1 and purpose = $2
       order by created_at desc limit 1`,
      [email, purpose],
    )
    const age = recent[0]?.age_seconds
    if (Number.isFinite(age) && age < config.auth.codeCooldownSeconds) {
      const wait = Math.max(1, config.auth.codeCooldownSeconds - age)
      throw new HttpError(429, `验证码刚发过，请 ${wait} 秒后再试`)
    }

    const { rows: hourly } = await query(
      config,
      `select count(*)::int as count
       from email_code
       where lower(email) = $1 and purpose = $2 and created_at > now() - interval '1 hour'`,
      [email, purpose],
    )
    if ((hourly[0]?.count ?? 0) >= config.auth.codeHourlyLimit) {
      throw new HttpError(429, '该邮箱一小时内获取验证码次数过多，请稍后再试')
    }

    const code = createCode()
    const { rows: inserted } = await query(
      config,
      `insert into email_code (email, purpose, code_hash, expires_at)
       values ($1, $2, $3, now() + ($4::int * interval '1 minute'))
       returning id, expires_at`,
      [email, purpose, hashCode(code, email, purpose), config.auth.codeMinutes],
    )

    // 只保留最新一条可用的码
    await query(
      config,
      `update email_code set consumed_at = now()
       where lower(email) = $1 and purpose = $2 and consumed_at is null and id < $3`,
      [email, purpose, inserted[0].id],
    ).catch(() => {})

    // 顺手清掉 7 天前的记录，验证码表不需要留历史
    query(config, "delete from email_code where created_at < now() - interval '7 days'").catch(() => {})

    let delivery
    try {
      delivery = await mailer.sendCode({ to: email, code, purpose })
    } catch (error) {
      // 发信失败时把刚插入的码作废，避免"收了钱没发货"的悬空状态
      await query(config, 'update email_code set consumed_at = now() where id = $1', [inserted[0].id]).catch(() => {})
      throw error
    }

    sendData(ctx.res, {
      sent: true,
      delivered: delivery.delivered,
      // 仅在本地显式打开 MAIL_DEV_ECHO=1 时回显，公网必须关掉
      ...(config.mail.devEcho ? { devCode: code } : {}),
      expiresInSeconds: config.auth.codeMinutes * 60,
    })
  }

  async function consumeCode(email, purpose, rawCode) {
    const code = String(rawCode ?? '').trim()
    if (!/^\d{6}$/.test(code)) {
      throw new HttpError(400, '请输入 6 位数字验证码')
    }

    const { rows } = await query(
      config,
      `select id, code_hash, expires_at, consumed_at, attempts
       from email_code
       where lower(email) = $1 and purpose = $2
       order by created_at desc limit 1`,
      [email, purpose],
    )
    const row = rows[0]
    if (!row) {
      throw new HttpError(400, '请先获取验证码')
    }
    if (row.consumed_at) {
      throw new HttpError(400, '验证码已使用，请重新获取')
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      throw new HttpError(400, '验证码已过期，请重新获取')
    }
    if (row.attempts >= config.auth.codeMaxAttempts) {
      throw new HttpError(429, '验证码错误次数过多，请重新获取')
    }

    if (!safeEqualHex(hashCode(code, email, purpose), row.code_hash)) {
      await query(config, 'update email_code set attempts = attempts + 1 where id = $1', [row.id])
      throw new HttpError(400, '验证码不正确')
    }

    await query(config, 'update email_code set consumed_at = now() where id = $1', [row.id])
  }

  async function startSession(ctx, user, res, verifiedBy = 'password') {
    const session = await createSession(config, user.id, {
      userAgent: ctx.req.headers?.['user-agent'] ?? '',
      verifiedBy,
    })
    sendData(res, {
      token: session.token,
      expiresAt: session.expiresAt,
      expiresInDays: session.expiresInDays,
      user: toPublicUser(user),
    })
  }

  async function register(ctx) {
    assertSecureForAuth(ctx.req, { allowInsecure: config.auth.allowInsecure })

    const body = await readJsonBody(ctx.req)
    const email = normalizeEmail(body.email)
    const password = assertPasswordStrength(body.password)

    registerIpLimiter(clientIpFor(ctx.req, { trustProxy: true }))

    if (await findUser(email)) {
      throw new HttpError(409, '该邮箱已注册，请直接登录')
    }

    await consumeCode(email, 'register', body.code)

    let user
    try {
      user = await withTransaction(config, async (client) => {
        const { rows } = await client.query(
          `insert into app_user (email, password_hash, display_name)
           values ($1, $2, $3) returning ${USER_COLUMNS}`,
          [email, await hashPassword(password), email.split('@')[0]],
        )
        const created = rows[0]

        // 邮箱本身也是一种身份，和微信身份同一张表，账号页才能统一列出登录方式
        await client.query(
          `insert into user_identity (user_id, provider, channel, provider_uid, nickname)
           values ($1, 'email', 'email', $2, $3)
           on conflict do nothing`,
          [created.id, email, created.display_name],
        )

        return created
      })
    } catch (error) {
      if (String(error?.code) === '23505') {
        throw new HttpError(409, '该邮箱已注册，请直接登录')
      }
      throw error
    }

    await startSession(ctx, user, ctx.res)
  }

  async function login(ctx) {
    assertSecureForAuth(ctx.req, { allowInsecure: config.auth.allowInsecure })

    const body = await readJsonBody(ctx.req)
    const email = normalizeEmail(body.email)

    const ip = clientIpFor(ctx.req, { trustProxy: true })
    loginIpLimiter(ip)
    loginEmailLimiter(email)

    let user
    let verifiedBy = 'password'

    if (body.code !== undefined && body.code !== null && String(body.code).trim() !== '') {
      // 先校验验证码，再决定建号：验证码通过等于邮箱归属已经证明
      await consumeCode(email, 'login', body.code)
      user = (await findUser(email)) ?? (await createEmailUser(email))
      verifiedBy = 'code'
    } else {
      const password = String(body.password ?? '')
      if (!password) {
        throw new HttpError(400, '请输入密码或验证码')
      }
      user = await findUser(email)
      // 微信建的账号、验证码登录自动建的账号都还没有密码，直接指路验证码，别让人猜
      if (user && !user.password_hash) {
        throw new HttpError(401, '这个账号还没有设置密码，请用验证码登录后设置')
      }
      // 邮箱不存在也跑一次 scrypt：响应时间不泄露「这个邮箱有没有注册」
      const stored = user?.password_hash ?? (await getDummyHash())
      const matched = await verifyPassword(password, stored)
      if (!user || !matched) {
        throw new HttpError(401, '邮箱或密码不正确')
      }
    }

    await query(config, 'update app_user set last_login_at = now() where id = $1', [user.id])
    await startSession(ctx, user, ctx.res, verifiedBy)
  }

  /** 设置 / 修改密码。授权规则见文件头注释。 */
  async function setPassword(ctx) {
    assertSecureForAuth(ctx.req, { allowInsecure: config.auth.allowInsecure })

    const session = await requireSession(config, ctx.req)
    const body = await readJsonBody(ctx.req)
    const password = assertPasswordStrength(body.password)

    const user = await findUserById(session.user.id)
    if (!user) {
      throw new HttpError(404, '账号不存在或已注销')
    }
    // 密码登录的唯一标识是邮箱：微信建的账号得先绑定邮箱
    if (!user.email) {
      throw new HttpError(400, '请先绑定邮箱，才能用密码登录')
    }

    loginIpLimiter(clientIpFor(ctx.req, { trustProxy: true }))
    loginEmailLimiter(user.email)

    if (user.password_hash) {
      const currentPassword = String(body.currentPassword ?? '')
      const code = String(body.code ?? '').trim()
      if (currentPassword) {
        if (!(await verifyPassword(currentPassword, user.password_hash))) {
          throw new HttpError(401, '当前密码不正确')
        }
      } else if (code) {
        await consumeCode(user.email, 'login', code)
      } else if (session.verifiedBy !== 'code') {
        throw new HttpError(400, '请输入当前密码；忘记密码可以退出后用验证码登录再重设')
      }
    }

    const passwordHash = await hashPassword(password)
    await query(
      config,
      'update app_user set password_hash = $2, password_updated_at = now() where id = $1',
      [user.id, passwordHash],
    )

    // 密码是长期凭据：改完把其他设备上的会话踢掉，只留当前这枚
    const revokedSessions = await destroyOtherSessions(config, user.id, session.sessionId).catch(() => 0)

    const updated = await findUserById(user.id)
    sendData(ctx.res, { ok: true, revokedSessions, user: toPublicUser(updated) })
  }

  /** 给还没有邮箱的账号（微信建的）绑定邮箱，绑定后就能设置密码 / 用验证码登录。 */
  async function bindEmail(ctx) {
    assertSecureForAuth(ctx.req, { allowInsecure: config.auth.allowInsecure })

    const session = await requireSession(config, ctx.req)
    const body = await readJsonBody(ctx.req)
    const email = normalizeEmail(body.email)

    const user = await findUserById(session.user.id)
    if (!user) {
      throw new HttpError(404, '账号不存在或已注销')
    }
    if (user.email) {
      throw new HttpError(409, '当前账号已绑定邮箱，暂不支持更换')
    }

    loginIpLimiter(clientIpFor(ctx.req, { trustProxy: true }))

    if (await findUser(email)) {
      throw new HttpError(409, '该邮箱已被其他账号使用，请换一个')
    }

    await consumeCode(email, 'bind', body.code)

    const displayName = user.display_name || email.split('@')[0]
    try {
      await withTransaction(config, async (client) => {
        await client.query(
          `update app_user set email = $2, display_name = coalesce(nullif(display_name, ''), $3)
           where id = $1`,
          [user.id, email, displayName],
        )
        await client.query(
          `insert into user_identity (user_id, provider, channel, provider_uid, nickname, last_login_at)
           values ($1, 'email', 'email', $2, $3, now())
           on conflict do nothing`,
          [user.id, email, displayName],
        )
      })
    } catch (error) {
      if (String(error?.code) === '23505') {
        throw new HttpError(409, '该邮箱已被其他账号使用，请换一个')
      }
      throw error
    }

    const updated = await findUserById(user.id)
    sendData(ctx.res, { ok: true, user: toPublicUser(updated) })
  }

  async function logout(ctx) {
    await destroySession(config, ctx.req)
    sendData(ctx.res, { ok: true })
  }

  async function me(ctx) {
    const session = await requireSession(config, ctx.req)
    sendData(ctx.res, { user: session.user })
  }

  return { issueCode, register, login, setPassword, bindEmail, logout, me }
}
