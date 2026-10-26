import { createHash, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

import { HttpError } from './lib.mjs'

/**
 * 认证原语：密码哈希、验证码、会话 token。
 *
 * 不引第三方库（bcrypt/jsonwebtoken），只用 node:crypto：
 *   - 密码用 scrypt + 16 字节随机盐，库里只存 `scrypt$<salt>$<hash>`；
 *   - 验证码 6 位数字，库里只存 sha256(code:email:purpose)，10 分钟过期；
 *   - 会话是不透明随机 token，库里只存 sha256(token)，可直接吊销。
 */

const scrypt = promisify(scryptCallback)

const PASSWORD_PREFIX = 'scrypt'
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase()
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new HttpError(400, '邮箱格式不正确')
  }
  return email
}

/** 密码规则：8–72 字符。上限来自 scrypt 的可用性，也顺便挡住超长请求体。 */
export function assertPasswordStrength(password) {
  const text = String(password ?? '')
  if (text.length < 8) {
    throw new HttpError(400, '密码至少 8 位')
  }
  if (text.length > 72) {
    throw new HttpError(400, '密码不能超过 72 位')
  }
  return text
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const derived = await scrypt(password, salt, 64)
  return `${PASSWORD_PREFIX}$${salt}$${derived.toString('hex')}`
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$')
  if (parts.length !== 3 || parts[0] !== PASSWORD_PREFIX) {
    return false
  }
  const [, salt, expectedHex] = parts
  let expected
  try {
    expected = Buffer.from(expectedHex, 'hex')
  } catch {
    return false
  }
  if (expected.length !== 64) {
    return false
  }
  const derived = await scrypt(String(password ?? ''), salt, 64)
  return timingSafeEqual(derived, expected)
}

/** 6 位数字验证码（000000–999999，保留前导零）。 */
export function createCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export function hashCode(code, email, purpose) {
  return createHash('sha256')
    .update(`${String(code ?? '').trim()}:${normalizeEmail(email)}:${purpose}`)
    .digest('hex')
}

/** 会话 token：256 位随机数，base64url。 */
export function createSessionToken() {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token) {
  return createHash('sha256').update(String(token ?? '')).digest('hex')
}

/** 从 `Authorization: Bearer xxx` 取 token；也接受 `x-session-token`（方便 curl）。 */
export function readToken(req) {
  const header = req.headers?.authorization
  const raw = Array.isArray(header) ? header[0] : (header ?? '')
  const match = /^Bearer\s+(.+)$/i.exec(String(raw).trim())
  if (match) {
    return match[1].trim()
  }
  const fallback = req.headers?.['x-session-token']
  const value = Array.isArray(fallback) ? fallback[0] : fallback
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/** 常量时间比较两个 hex 串，避免验证码被计时侧信道枚举。 */
export function safeEqualHex(a, b) {
  const left = Buffer.from(String(a ?? ''), 'hex')
  const right = Buffer.from(String(b ?? ''), 'hex')
  if (left.length !== right.length || left.length === 0) {
    return false
  }
  return timingSafeEqual(left, right)
}
