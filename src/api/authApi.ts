import { apiUrl } from './base'
import { request } from './httpClient'

/** 登录/注册接口。会话 token 由调用方存进 authStore，这里不碰存储。 */

export type AuthUser = {
  id: string
  /** 微信首次登录的账号没有邮箱；「验证码登录即注册」的账号有邮箱但没密码 */
  email: string | null
  displayName: string | null
  avatarUrl: string | null
  /** 是否已设置密码。false = 只能用验证码登录，账号页会给「设置密码」入口 */
  hasPassword: boolean
  createdAt: string
}

export type AuthSession = {
  token: string
  expiresAt: string
  expiresInDays: number
  user: AuthUser
}

type Envelope<T> = {
  success: boolean
  data: T
  errorMessage?: string
}

const JSON_HEADERS = { 'content-type': 'application/json' }

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const response = await request<Envelope<T>>(apiUrl(path), {
    method: 'POST',
    headers: token ? { ...JSON_HEADERS, authorization: `Bearer ${token}` } : JSON_HEADERS,
    body: JSON.stringify(body),
  })
  return response.data
}

export type CodeResponse = {
  sent: boolean
  delivered: boolean
  /** 只在本地开发（MAIL_DEV_ECHO=1）返回，线上恒为空 */
  devCode?: string
  expiresInSeconds: number
}

/** register = 注册；login = 验证码登录（未注册邮箱会顺手建号）；bind = 给当前账号绑定邮箱（要带 token） */
export type CodePurpose = 'register' | 'login' | 'bind'

export function requestEmailCode(email: string, purpose: CodePurpose, token?: string) {
  return post<CodeResponse>('/api/auth/code', { email, purpose }, token)
}

export function registerAccount(input: { email: string; password: string; code: string }) {
  return post<AuthSession>('/api/auth/register', input)
}

export function loginWithPassword(email: string, password: string) {
  return post<AuthSession>('/api/auth/login', { email, password })
}

export function loginWithCode(email: string, code: string) {
  return post<AuthSession>('/api/auth/login', { email, code })
}

// ---------------------------------------------------------------------------
// 账号安全：设置密码 / 绑定邮箱（都要登录）
// ---------------------------------------------------------------------------

export type PasswordResult = {
  ok: boolean
  /** 改密码时被吊销的其他设备会话数 */
  revokedSessions: number
  user: AuthUser
}

/**
 * 设置 / 修改密码（需要登录）。
 *
 * - 还没有密码的账号（验证码登录自动建的、微信建的）：只传 password；
 * - 已有密码：传 currentPassword；「验证码登录」的会话也可以不传，直接覆盖；
 * - 忘记当前密码又不是验证码登录的会话：先 `requestEmailCode(email, 'login')`，再传 code。
 */
export function setPassword(
  token: string,
  input: { password: string; currentPassword?: string; code?: string },
) {
  return post<PasswordResult>('/api/auth/password', input, token)
}

/** 给还没有邮箱的账号绑定邮箱（需要登录 + 发到新邮箱的验证码）。 */
export async function bindEmail(token: string, input: { email: string; code: string }): Promise<AuthUser> {
  const result = await post<{ ok: boolean; user: AuthUser }>('/api/auth/email', input, token)
  return result.user
}

export async function fetchMe(token: string): Promise<AuthUser> {
  const response = await request<Envelope<{ user: AuthUser }>>(apiUrl('/api/auth/me'), {
    headers: { authorization: `Bearer ${token}` },
  })
  return response.data.user
}

export async function logoutRequest(token: string) {
  try {
    await request<Envelope<{ ok: boolean }>>(apiUrl('/api/auth/logout'), {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
      body: '{}',
    })
  } catch {
    // token 已经失效也无所谓，本地清掉即可
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 第三方身份（当前只有微信；架构上按 provider/channel 区分）
// ---------------------------------------------------------------------------

export type IdentityProvider = 'email' | 'wechat'
export type IdentityChannel = 'email' | 'wechat_web' | 'wechat_mp'

export type Identity = {
  provider: IdentityProvider
  channel: IdentityChannel
  nickname: string
  avatarUrl: string | null
  /** openid 只回末四位 */
  uidHint: string
  createdAt: string
  lastLoginAt: string | null
}

export type WechatConfig = {
  enabled: boolean
  channels: IdentityChannel[]
  /** 服务端配置的回调地址（未配置时为 null） */
  redirectUri: string | null
  /** 还缺哪些环境变量 */
  missing: string[]
}

export async function getWechatConfig(): Promise<WechatConfig> {
  const response = await request<Envelope<WechatConfig>>(apiUrl('/api/auth/wechat/config'))
  return response.data
}

/** 拿授权地址。mode=bind 时必须带 token（把微信绑到当前账号）。 */
export async function startWechat(mode: 'login' | 'bind', token?: string): Promise<string> {
  const response = await request<Envelope<{ authorizeUrl: string }>>(
    apiUrl(`/api/auth/wechat/start?mode=${mode}`),
    { headers: token ? { authorization: `Bearer ${token}` } : {} },
  )
  return response.data.authorizeUrl
}

/** 用回调带回来的一次性票据换正式会话。 */
export function exchangeWechatTicket(ticket: string) {
  return post<AuthSession>('/api/auth/wechat/session', { ticket })
}

export async function fetchIdentities(token: string): Promise<Identity[]> {
  const response = await request<Envelope<{ items: Identity[] }>>(apiUrl('/api/auth/identities'), {
    headers: { authorization: `Bearer ${token}` },
  })
  return response.data.items
}

export async function unbindIdentity(token: string, provider: IdentityProvider) {
  await request<Envelope<{ ok: boolean }>>(apiUrl(`/api/auth/identities/${provider}`), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })
}
