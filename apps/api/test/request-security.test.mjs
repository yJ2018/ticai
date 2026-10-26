import assert from 'node:assert/strict'
import test from 'node:test'

import { assertSecureForAuth, isLocalRequest, isSecureRequest } from '../src/lib.mjs'

function fakeReq({ headers = {}, remoteAddress = '203.0.113.9', encrypted = false } = {}) {
  return { headers, socket: { remoteAddress, encrypted } }
}

test('isSecureRequest：反代与直连两种形态', () => {
  assert.equal(isSecureRequest(fakeReq({ headers: { 'x-forwarded-proto': 'https' } })), true)
  assert.equal(isSecureRequest(fakeReq({ headers: { 'x-forwarded-proto': 'https,http' } })), true)
  assert.equal(isSecureRequest(fakeReq({ headers: { 'x-forwarded-proto': 'http' } })), false)
  assert.equal(isSecureRequest(fakeReq({ encrypted: true })), true)
  assert.equal(isSecureRequest(fakeReq()), false)
})

test('isLocalRequest：本机与内网 Host 放行，公网 Host 不放行', () => {
  assert.equal(isLocalRequest(fakeReq({ headers: { host: '127.0.0.1:5199' } })), true)
  assert.equal(isLocalRequest(fakeReq({ headers: { host: 'localhost:3001' } })), true)
  assert.equal(isLocalRequest(fakeReq({ headers: { host: 'ticai.example.com' } })), false)

  // 局域网调试：Host 是内网地址字面量
  assert.equal(isLocalRequest(fakeReq({ headers: { host: '192.168.1.9:5199' } })), true)
  assert.equal(isLocalRequest(fakeReq({ headers: { host: '10.0.0.8:3001' } })), true)

  // 反代到应用时 socket 一定是回环/内网，不能用来源 IP 判断
  assert.equal(
    isLocalRequest(fakeReq({ headers: { host: 'ticai.example.com' }, remoteAddress: '127.0.0.1' })),
    false,
  )
})

test('assertSecureForAuth：公网明文拒绝，本机/HTTPS/显式放行', () => {
  const publicReq = fakeReq({ headers: { host: 'ticai.example.com', 'x-forwarded-proto': 'http' } })
  assert.throws(
    () => assertSecureForAuth(publicReq),
    (error) => error.status === 403 && /HTTPS/.test(error.message),
  )

  const httpsReq = fakeReq({ headers: { host: 'ticai.example.com', 'x-forwarded-proto': 'https' } })
  assert.doesNotThrow(() => assertSecureForAuth(httpsReq))

  const localReq = fakeReq({ headers: { host: '127.0.0.1:5199' } })
  assert.doesNotThrow(() => assertSecureForAuth(localReq))

  assert.doesNotThrow(() => assertSecureForAuth(publicReq, { allowInsecure: true }))
})
