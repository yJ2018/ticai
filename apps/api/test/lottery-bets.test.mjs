import test from 'node:test'
import assert from 'node:assert/strict'

import {
  judgeLotteryBet,
  normalizeLotteryNumbers,
  resolveLotteryGame,
} from '../src/lottery-settlement.mjs'

test('彩种解析支持 gameKey 与 gameNo', () => {
  assert.equal(resolveLotteryGame('pl5')?.gameNo, '350133')
  assert.equal(resolveLotteryGame('350133')?.key, 'pl5')
  assert.equal(resolveLotteryGame('dlt')?.name, '超级大乐透')
  assert.equal(resolveLotteryGame('nope'), null)
})

test('排列五：必须是 5 位 0–9，按位判定', () => {
  const numbers = normalizeLotteryNumbers('pl5', { main: [1, 5, 4, 4, 8] })
  assert.deepEqual(numbers, { main: [1, 5, 4, 4, 8], extra: [] })

  const draw = { issue: '26287', draw_date: '2026-10-28', main_numbers: [1, 5, 4, 4, 8], extra_numbers: [] }
  const hit = judgeLotteryBet('pl5', numbers, draw)
  assert.equal(hit.status, 'won')
  assert.equal(hit.tier, '一等奖')
  assert.equal(hit.hits.main, 5)
  assert.ok(hit.matchedMain.every(Boolean))

  const miss = judgeLotteryBet('pl5', { main: [1, 5, 4, 4, 9] }, draw)
  assert.equal(miss.status, 'lost')
  assert.equal(miss.tier, null)
  assert.equal(miss.hits.main, 4)

  assert.throws(() => normalizeLotteryNumbers('pl5', { main: [1, 5, 4, 4] }), /需要选 5 个号码/)
  assert.throws(() => normalizeLotteryNumbers('pl5', { main: [1, 5, 4, 4, 10] }), /0–9/)
})

test('七星彩：7 位数字，按位判定', () => {
  const numbers = normalizeLotteryNumbers('qxc', { main: [1, 2, 3, 4, 5, 6, 7] })
  assert.equal(numbers.main.length, 7)

  const won = judgeLotteryBet('qxc', numbers, {
    issue: '26100',
    draw_date: '2026-10-29',
    main_numbers: [1, 2, 3, 4, 5, 6, 7],
    extra_numbers: [],
  })
  assert.equal(won.status, 'won')

  const lost = judgeLotteryBet('qxc', numbers, {
    issue: '26101',
    draw_date: '2026-10-30',
    main_numbers: [1, 2, 3, 4, 5, 6, 9],
    extra_numbers: [],
  })
  assert.equal(lost.status, 'lost')
  assert.equal(lost.hits.main, 6)
})

test('大乐透：排序去重 + 九个奖级', () => {
  const numbers = normalizeLotteryNumbers('dlt', { main: [32, 1, 6, 10, 15], extra: [8, 3] })
  assert.deepEqual(numbers, { main: [1, 6, 10, 15, 32], extra: [3, 8] })

  const draw = {
    issue: '26100',
    draw_date: '2026-10-29',
    main_numbers: [1, 6, 10, 15, 32],
    extra_numbers: [3, 8],
  }

  const cases = [
    { main: [1, 6, 10, 15, 32], extra: [3, 8], tier: '一等奖' },
    { main: [1, 6, 10, 15, 32], extra: [3, 9], tier: '二等奖' },
    { main: [1, 6, 10, 15, 32], extra: [9, 10], tier: '三等奖' },
    { main: [1, 6, 10, 15, 33], extra: [3, 8], tier: '四等奖' },
    { main: [1, 6, 10, 15, 33], extra: [3, 9], tier: '五等奖' },
    { main: [1, 6, 10, 33, 34], extra: [3, 8], tier: '六等奖' },
    { main: [1, 6, 10, 15, 33], extra: [9, 10], tier: '七等奖' },
    { main: [1, 6, 10, 33, 34], extra: [3, 9], tier: '八等奖' },
    { main: [1, 6, 10, 33, 34], extra: [9, 10], tier: '九等奖' },
  ]

  for (const item of cases) {
    const judged = judgeLotteryBet('dlt', { main: item.main, extra: item.extra }, draw)
    assert.equal(judged.tier, item.tier, `${item.main.join(',')}+${item.extra.join(',')}`)
    assert.equal(judged.status, 'won')
  }

  const lost = judgeLotteryBet('dlt', { main: [2, 7, 11, 16, 33], extra: [9, 10] }, draw)
  assert.equal(lost.status, 'lost')
  assert.equal(lost.tier, null)

  assert.throws(
    () => normalizeLotteryNumbers('dlt', { main: [1, 1, 6, 10, 15], extra: [3, 8] }),
    /不能重复/,
  )
  assert.throws(() => normalizeLotteryNumbers('dlt', { main: [1, 6, 10, 15, 36], extra: [3, 8] }), /1–35/)
})

test('没有开奖时一律 pending', () => {
  const judged = judgeLotteryBet('pl5', { main: [1, 2, 3, 4, 5], extra: [] }, null)
  assert.equal(judged.status, 'pending')
  assert.equal(judged.draw, null)
})
