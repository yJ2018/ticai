import assert from 'node:assert/strict'
import test from 'node:test'

import { assertPasswordStrength } from '../src/auth.mjs'
import { HttpError } from '../src/lib.mjs'
import { toPublicUser } from '../src/session.mjs'

/**
 * 账号资料的对外形状 + 密码规则。
 *
 * 这里只测纯函数：`toPublicUser` 决定账号页显示「设置密码」还是「修改密码」，
 * 一旦 hasPassword 判错，用户会看到一个要填当前密码的表单而他根本没有密码。
 */

test('toPublicUser：验证码登录建的无密码账号 → hasPassword false', () => {
  const user = toPublicUser({
    id: 7,
    email: 'new@example.com',
    password_hash: null,
    has_password: false,
    display_name: 'new',
    avatar_url: null,
    created_at: new Date('2026-10-29T00:00:00Z'),
  })

  assert.equal(user.hasPassword, false)
  assert.equal(user.email, 'new@example.com')
  assert.equal(user.id, '7')
  assert.equal(user.createdAt, '2026-10-29T00:00:00.000Z')
})

test('toPublicUser：有密码的账号 → hasPassword true', () => {
  const user = toPublicUser({ id: 1, email: 'a@b.com', has_password: true })
  assert.equal(user.hasPassword, true)
})

test('toPublicUser：查询只带 password_hash 时按哈希推导', () => {
  assert.equal(toPublicUser({ id: 1, email: 'a@b.com', password_hash: 'scrypt$x$y' }).hasPassword, true)
  assert.equal(toPublicUser({ id: 1, email: 'a@b.com', password_hash: null }).hasPassword, false)
})

test('toPublicUser：微信建的账号可以没有邮箱', () => {
  const user = toPublicUser({ id: 2, email: null, password_hash: null, display_name: '微信用户' })
  assert.equal(user.email, null)
  assert.equal(user.hasPassword, false)
  assert.equal(user.displayName, '微信用户')
})

test('密码规则：8–72 位，越界返回 400', () => {
  assert.equal(assertPasswordStrength('12345678'), '12345678')
  assert.throws(
    () => assertPasswordStrength('1234567'),
    (error) => error instanceof HttpError && error.status === 400,
  )
  assert.throws(
    () => assertPasswordStrength('x'.repeat(73)),
    (error) => error instanceof HttpError && error.status === 400,
  )
})
