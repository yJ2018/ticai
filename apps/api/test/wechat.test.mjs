import assert from 'node:assert/strict'
import test from 'node:test'

import { HttpError } from '../src/lib.mjs'
import { WECHAT_CHANNELS, createWechatService } from '../src/wechat.mjs'

function makeConfig(overrides = {}) {
  return {
    auth: { stateSecret: 'test-state-secret', ticketSeconds: 120 },
    wechat: {
      appId: '',
      appSecret: '',
      redirectUri: '',
      mpAppId: '',
      mpAppSecret: '',
      mpRedirectUri: '',
      ...overrides,
    },
  }
}

test('state：签名后可校验，字段不丢', () => {
  const service = createWechatService(makeConfig())
  const state = service.signState({ mode: 'bind', channel: WECHAT_CHANNELS.web, userId: '42' })
  const payload = service.verifyState(state)

  assert.equal(payload.mode, 'bind')
  assert.equal(payload.channel, 'wechat_web')
  assert.equal(payload.userId, '42')
})

test('state：篡改或换密钥都会被拒绝', () => {
  const service = createWechatService(makeConfig())
  const state = service.signState({ mode: 'login', channel: WECHAT_CHANNELS.web })

  const [version, body, signature] = state.split('.')
  const tampered = `${version}.${body.slice(0, -2)}AA.${signature}`
  assert.throws(() => service.verifyState(tampered), HttpError)

  const otherConfig = makeConfig()
  otherConfig.auth = { ...otherConfig.auth, stateSecret: 'another-secret' }
  const otherService = createWechatService(otherConfig)
  assert.throws(() => otherService.verifyState(state), /校验失败/)
})

test('state：过期直接拒绝', () => {
  const service = createWechatService(makeConfig())
  const state = service.signState({ mode: 'login', channel: WECHAT_CHANNELS.web })

  const originalNow = Date.now
  Date.now = () => originalNow() + 11 * 60 * 1000
  try {
    assert.throws(() => service.verifyState(state), /超时/)
  } finally {
    Date.now = originalNow
  }
})

test('没有配置任何凭据时，start 会给出明确错误', () => {
  const service = createWechatService(makeConfig())
  assert.equal(service.describe().enabled, false)
  assert.throws(
    () => service.buildAuthorizeUrl({ mode: 'login', channel: WECHAT_CHANNELS.web, state: 'x' }),
    /未配置/,
  )
})

test('扫码登录：授权地址带 appid / redirect_uri / state', () => {
  const service = createWechatService(
    makeConfig({ appId: 'wx123', appSecret: 's3cret', redirectUri: 'https://api.example.com/api/auth/wechat/callback' }),
  )
  assert.equal(service.describe().enabled, true)

  const url = new URL(
    service.buildAuthorizeUrl({ mode: 'login', channel: WECHAT_CHANNELS.web, state: 'signed-state' }),
  )
  assert.equal(url.origin + url.pathname, 'https://open.weixin.qq.com/connect/qrconnect')
  assert.equal(url.searchParams.get('appid'), 'wx123')
  assert.equal(url.searchParams.get('redirect_uri'), 'https://api.example.com/api/auth/wechat/callback')
  assert.equal(url.searchParams.get('scope'), 'snsapi_login')
  assert.equal(url.searchParams.get('state'), 'signed-state')
})

test('公众号网页授权：走 oauth2/authorize 且 scope=snsapi_userinfo', () => {
  const service = createWechatService(
    makeConfig({
      mpAppId: 'mp123',
      mpAppSecret: 'mp-secret',
      mpRedirectUri: 'https://api.example.com/api/auth/wechat/callback',
    }),
  )
  const url = new URL(
    service.buildAuthorizeUrl({ mode: 'login', channel: WECHAT_CHANNELS.mp, state: 'signed-state' }),
  )
  assert.equal(url.origin + url.pathname, 'https://open.weixin.qq.com/connect/oauth2/authorize')
  assert.equal(url.searchParams.get('appid'), 'mp123')
  assert.equal(url.searchParams.get('scope'), 'snsapi_userinfo')
})

test('未配置时：describe 报出缺失项，start 给出 503', () => {
  const service = createWechatService(makeConfig())
  const description = service.describe()

  assert.equal(description.enabled, false)
  assert.deepEqual(description.missing, ['WECHAT_APP_ID', 'WECHAT_APP_SECRET', 'WECHAT_REDIRECT_URI'])
  assert.throws(
    () => service.buildAuthorizeUrl({ mode: 'login', channel: WECHAT_CHANNELS.web, state: 'x' }),
    (error) => error instanceof HttpError && error.status === 503,
  )
})
