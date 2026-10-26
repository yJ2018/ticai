import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { HttpError } from './lib.mjs'

/**
 * 微信登录适配层（开放平台「网站应用」扫码 / 公众号网页授权）。
 *
 * 这里只做三件事：拼授权地址、校验 state、用 code 换身份。
 * 账号怎么建、身份怎么绑，交给 handlers/wechat.mjs —— 这样以后接小程序、
 * Apple、GitHub 时，只要再写一个同样形状的适配器。
 *
 * 没配置 AppID / AppSecret / 回调地址时 `enabled` 为 false：
 * 前端不会发起授权，而是展示「接入步骤」；邮箱登录与投注不受影响。
 */

const QR_CONNECT = 'https://open.weixin.qq.com/connect/qrconnect'
const OAUTH2_AUTHORIZE = 'https://open.weixin.qq.com/connect/oauth2/authorize'
const ACCESS_TOKEN_URL = 'https://api.weixin.qq.com/sns/oauth2/access_token'
const USERINFO_URL = 'https://api.weixin.qq.com/sns/userinfo'

export const WECHAT_CHANNELS = {
  web: 'wechat_web',
  mp: 'wechat_mp',
}

const STATE_VERSION = 'v1'
const STATE_TTL_MS = 10 * 60 * 1000

function base64url(input) {
  return Buffer.from(input, 'utf8').toString('base64url')
}

function hmac(secret, text) {
  return createHmac('sha256', secret).update(text).digest('base64url')
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length || left.length === 0) {
    return false
  }
  return timingSafeEqual(left, right)
}

async function fetchWechatJson(url, timeoutMs = 10_000) {
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new HttpError(502, `微信接口连接失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const text = await response.text()
  if (!response.ok) {
    throw new HttpError(502, `微信接口返回 HTTP ${response.status}`)
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(502, '微信接口返回了非 JSON 内容')
  }
}

export function createWechatService(config) {
  const { appId, appSecret, redirectUri, mpAppId, mpAppSecret, mpRedirectUri } = config.wechat

  const stateSecret = config.auth.stateSecret || appSecret || ''
  const webEnabled = Boolean(appId && appSecret && redirectUri)
  const mpEnabled = Boolean(mpAppId && mpAppSecret && mpRedirectUri)
  const enabled = webEnabled || mpEnabled

  function assertStateSecret() {
    if (!stateSecret) {
      throw new HttpError(
        503,
        '微信登录未配置：需要设置 WECHAT_APP_ID / WECHAT_APP_SECRET / WECHAT_REDIRECT_URI（或 AUTH_STATE_SECRET）',
      )
    }
  }

  /** state 里带 mode 与绑定用户，签名后随回调带回，防 CSRF 与串号。 */
  function signState({ mode, channel, userId = null }) {
    assertStateSecret()
    const payload = {
      v: STATE_VERSION,
      m: mode === 'bind' ? 'bind' : 'login',
      ch: channel,
      uid: userId ? String(userId) : null,
      exp: Date.now() + STATE_TTL_MS,
      n: randomBytes(8).toString('base64url'),
    }
    const body = base64url(JSON.stringify(payload))
    return `${STATE_VERSION}.${body}.${hmac(stateSecret, body)}`
  }

  function verifyState(state) {
    assertStateSecret()
    const parts = String(state ?? '').split('.')
    if (parts.length !== 3 || parts[0] !== STATE_VERSION) {
      throw new HttpError(400, '微信授权状态无效，请重新发起')
    }
    const [, body, signature] = parts
    if (!safeEqual(signature, hmac(stateSecret, body))) {
      throw new HttpError(400, '微信授权状态校验失败，请重新发起')
    }

    let payload
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    } catch {
      throw new HttpError(400, '微信授权状态无法解析')
    }

    if (!payload || payload.v !== STATE_VERSION || typeof payload.exp !== 'number') {
      throw new HttpError(400, '微信授权状态格式不正确')
    }
    if (payload.exp < Date.now()) {
      throw new HttpError(400, '微信授权已超时，请重新发起')
    }

    return {
      mode: payload.m === 'bind' ? 'bind' : 'login',
      channel: Object.values(WECHAT_CHANNELS).includes(payload.ch) ? payload.ch : WECHAT_CHANNELS.web,
      userId: payload.uid ? String(payload.uid) : null,
    }
  }

  function resolveChannel(channel) {
    return channel === WECHAT_CHANNELS.mp ? WECHAT_CHANNELS.mp : WECHAT_CHANNELS.web
  }

  function buildAuthorizeUrl({ mode, channel, state }) {
    const resolved = resolveChannel(channel)

    if (resolved === WECHAT_CHANNELS.mp) {
      if (!mpEnabled) {
        throw new HttpError(503, '微信网页授权未配置：需要 WECHAT_MP_APP_ID / WECHAT_MP_APP_SECRET / WECHAT_MP_REDIRECT_URI')
      }
      const params = new URLSearchParams({
        appid: mpAppId,
        redirect_uri: mpRedirectUri,
        response_type: 'code',
        scope: 'snsapi_userinfo',
        state,
      })
      return `${OAUTH2_AUTHORIZE}?${params.toString()}#wechat_redirect`
    }

    if (!webEnabled) {
      throw new HttpError(503, '微信登录未配置：需要 WECHAT_APP_ID / WECHAT_APP_SECRET / WECHAT_REDIRECT_URI')
    }

    const params = new URLSearchParams({
      appid: appId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'snsapi_login',
      state,
    })
    return `${QR_CONNECT}?${params.toString()}#wechat_redirect`
  }

  /**
   * code → 微信身份。
   * 返回 { openid, unionid, nickname, avatarUrl, raw }，与具体渠道无关。
   */
  async function exchangeCode({ code, channel, timeoutMs = 10_000 }) {
    const resolved = resolveChannel(channel)

    if (!appSecret) {
      throw new HttpError(503, '微信登录未配置')
    }

    const tokenUrl = new URL(ACCESS_TOKEN_URL)
    tokenUrl.searchParams.set('appid', resolved === WECHAT_CHANNELS.mp ? mpAppId : appId)
    tokenUrl.searchParams.set('secret', resolved === WECHAT_CHANNELS.mp ? mpAppSecret : appSecret)
    tokenUrl.searchParams.set('code', String(code ?? ''))
    tokenUrl.searchParams.set('grant_type', 'authorization_code')

    const token = await fetchWechatJson(tokenUrl.toString(), timeoutMs)
    if (token.errcode) {
      throw new HttpError(502, `微信授权失败：${token.errmsg || token.errcode}`, String(token.errcode))
    }
    if (!token.openid || !token.access_token) {
      throw new HttpError(502, '微信授权返回缺少 openid / access_token')
    }

    const infoUrl = new URL(USERINFO_URL)
    infoUrl.searchParams.set('access_token', token.access_token)
    infoUrl.searchParams.set('openid', token.openid)
    infoUrl.searchParams.set('lang', 'zh_CN')

    const info = await fetchWechatJson(infoUrl.toString(), timeoutMs)
    if (info.errcode) {
      throw new HttpError(502, `微信用户信息获取失败：${info.errmsg || info.errcode}`, String(info.errcode))
    }

    return {
      openid: info.openid || token.openid,
      unionid: info.unionid || token.unionid || null,
      nickname: info.nickname || '',
      avatarUrl: info.headimgurl || '',
      raw: { ...info, scope: token.scope },
    }
  }

  function describe() {
    return {
      enabled,
      channels: [
        ...(webEnabled ? [WECHAT_CHANNELS.web] : []),
        ...(mpEnabled ? [WECHAT_CHANNELS.mp] : []),
      ],
      // 给前端「接入步骤」用：回调地址与当前缺哪些配置
      redirectUri: redirectUri || null,
      missing: [
        ...(appId ? [] : ['WECHAT_APP_ID']),
        ...(appSecret ? [] : ['WECHAT_APP_SECRET']),
        ...(redirectUri ? [] : ['WECHAT_REDIRECT_URI']),
      ],
    }
  }

  return { signState, verifyState, buildAuthorizeUrl, exchangeCode, describe }
}
