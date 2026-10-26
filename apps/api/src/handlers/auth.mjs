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
import { createSession, destroySession, requireSession, toPublicUser } from '../session.mjs'

/**
 * 可选登录：邮箱 + 密码 / 邮箱验证码。
 *
 * 验证码有两个用途：
 *   register —— 注册时验证邮箱归属；
 *   login    —— 免密登录（同样先证明邮箱归属）。
 *
 * 防滥用：同邮箱 60 秒冷却 + 每小时 6 次；同 IP 每小时 20 次；
 * 验证码 10 分钟过期、最多试 5 次，用完即作废。
 *
 * 密码永远不会落库或落日志：请求体只在内存里过一遍 scrypt，库里存 `scrypt$salt$hash`，
 * 请求日志只记 method / path / status。传输安全交给 HTTPS（见 assertSecureForAuth）。
 */

const CODE_PURPOSE = new Set(['register', 'login'])

export function createAuthHandlers(config) {
  const mailer = createMailer(config)
  const ipLimiter = createRateLimiter({
    limit: config.auth.codePerIpPerHour,
    windowMs: 3_600_000,
    maxKeys: 2_000,
  })

  // 密码登录/注册的暴力破解防护：同一 IP、同一邮箱分别限速
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
      'select id, email, password_hash, display_name, avatar_url, created_at from app_user where lower(email) = $1 limit 1',
      [email],
    )
    return rows[0] ?? null
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
    if (purpose === 'login' && !existing) {
      throw new HttpError(404, '该邮箱尚未注册，请先注册')
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

  async function startSession(ctx, user, res) {
    const session = await createSession(config, user.id, {
      userAgent: ctx.req.headers?.['user-agent'] ?? '',
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
          'insert into app_user (email, password_hash, display_name) values ($1, $2, $3) returning id, email, display_name, avatar_url, created_at',
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
    const user = await findUser(email)

    const ip = clientIpFor(ctx.req, { trustProxy: true })
    loginIpLimiter(ip)
    loginEmailLimiter(email)

    if (body.code !== undefined && body.code !== null && String(body.code).trim() !== '') {
      if (!user) {
        throw new HttpError(404, '该邮箱尚未注册，请先注册')
      }
      await consumeCode(email, 'login', body.code)
    } else {
      const password = String(body.password ?? '')
      if (!password) {
        throw new HttpError(400, '请输入密码或验证码')
      }
      // 邮箱不存在也跑一次 scrypt：响应时间不泄露「这个邮箱有没有注册」
      const stored = user?.password_hash ?? (await getDummyHash())
      const matched = await verifyPassword(password, stored)
      if (!user || !matched) {
        throw new HttpError(401, '邮箱或密码不正确')
      }
    }

    await query(config, 'update app_user set last_login_at = now() where id = $1', [user.id])
    await startSession(ctx, user, ctx.res)
  }

  async function logout(ctx) {
    await destroySession(config, ctx.req)
    sendData(ctx.res, { ok: true })
  }

  async function me(ctx) {
    const session = await requireSession(config, ctx.req)
    sendData(ctx.res, { user: session.user })
  }

  return { issueCode, register, login, logout, me }
}
