import { test } from 'node:test'
import assert from 'node:assert/strict'

import { msUntilNextDaily } from '../src/daily-schedule.mjs'

const hours = (ms) => ms / 3_600_000

test('每日调度：09:00 前触发，距下一个 09:00 不足 24 小时', () => {
  const ms = msUntilNextDaily(9, 0, new Date('2026-10-23T08:00:00+08:00'))
  assert.equal(hours(ms), 1)
})

test('每日调度：已过 09:00 则顺延到明天', () => {
  const ms = msUntilNextDaily(9, 0, new Date('2026-10-23T09:47:00+08:00'))
  assert.ok(Math.abs(hours(ms) - 23.2166) < 0.01)
})

test('每日调度：正好 09:00:00 视为已过，排到明天', () => {
  assert.equal(hours(msUntilNextDaily(9, 0, new Date('2026-10-23T09:00:00+08:00'))), 24)
})

test('每日调度：跨日边界（23:59）', () => {
  const ms = msUntilNextDaily(9, 0, new Date('2026-10-23T23:59:00+08:00'))
  assert.ok(Math.abs(hours(ms) - 9.0166) < 0.01)
})

test('每日调度：支持自定义分钟', () => {
  const ms = msUntilNextDaily(9, 30, new Date('2026-10-23T09:00:00+08:00'))
  assert.equal(hours(ms), 0.5)
})
