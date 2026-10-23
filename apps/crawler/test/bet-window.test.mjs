import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isBettingOpen, msUntilWindowOpen } from '../src/bet-window.mjs'

const config = { betWindowWeekday: '11:00-22:00', betWindowWeekend: '11:00-23:00' }
const hours = (ms) => ms / 3_600_000

test('开盘倒计时：10:30 → 0.5 小时', () => {
  const ms = msUntilWindowOpen(new Date('2026-10-23T10:30:00+08:00'), config)
  assert.ok(Math.abs(hours(ms) - 0.5) < 0.02)
})

test('开盘倒计时：已开盘则顺延到明天', () => {
  const ms = msUntilWindowOpen(new Date('2026-10-23T15:00:00+08:00'), config)
  assert.ok(Math.abs(hours(ms) - 20) < 0.02)
})

test('开盘倒计时：收盘后也顺延到明天', () => {
  const ms = msUntilWindowOpen(new Date('2026-10-23T23:30:00+08:00'), config)
  assert.ok(Math.abs(hours(ms) - 11.5) < 0.02)
})

test('闸门：11:00 整点算开盘', () => {
  assert.equal(isBettingOpen(new Date('2026-10-23T11:00:00+08:00'), config).open, true)
})

test('闸门：10:59 仍为停售', () => {
  assert.equal(isBettingOpen(new Date('2026-10-23T10:59:00+08:00'), config).open, false)
})
