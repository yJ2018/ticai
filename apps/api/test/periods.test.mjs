import assert from 'node:assert/strict'
import test from 'node:test'

import { periodLabel, weekdayLabel } from '../src/periods.mjs'

/**
 * 期（销售日）标签。
 *
 * 赛果页按期翻页：同一期的比赛可能横跨两个自然日（周六 021 开赛在周日 01:00），
 * 所以期的标签必须由「销售日」推出来，而不是开赛日。
 */
test('weekdayLabel: 销售日 → 周X', () => {
  assert.equal(weekdayLabel('2026-10-31'), '周六')
  assert.equal(weekdayLabel('2026-11-01'), '周日')
  assert.equal(weekdayLabel('2026-10-30'), '周五')
  assert.equal(weekdayLabel('2026-03-02'), '周一')
})

test('weekdayLabel: 非法输入返回空串', () => {
  assert.equal(weekdayLabel(''), '')
  assert.equal(weekdayLabel(null), '')
  assert.equal(weekdayLabel('2026-13-01'), '')
  assert.equal(weekdayLabel('20261031'), '')
})

test('periodLabel: 周X + 月-日', () => {
  assert.equal(periodLabel('2026-10-31'), '周六 10-31')
  assert.equal(periodLabel('2026-11-01'), '周日 11-01')
  assert.equal(periodLabel(''), '')
})
