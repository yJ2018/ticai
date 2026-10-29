import test from 'node:test'
import assert from 'node:assert/strict'

import {
  combinationCount,
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

test('组合数', () => {
  assert.equal(combinationCount(5, 5), 1)
  assert.equal(combinationCount(6, 5), 6)
  assert.equal(combinationCount(35, 5), 324632)
  assert.equal(combinationCount(3, 5), 0)
})

test('排列五：按位选号，单式 1 注、复式按位乘积', () => {
  const single = normalizeLotteryNumbers('pl5', { main: [[1], [5], [4], [4], [8]] })
  assert.deepEqual(single.numbers, { main: [[1], [5], [4], [4], [8]], extra: [] })
  assert.equal(single.units, 1)
  assert.equal(single.mode, 'single')

  const complex = normalizeLotteryNumbers('pl5', { main: [[1, 2, 3], [5], [4], [4], [8]] })
  assert.equal(complex.units, 3)
  assert.equal(complex.mode, 'multiple')

  const draw = { issue: '26287', draw_date: '2026-10-28', main_numbers: [1, 5, 4, 4, 8], extra_numbers: [] }
  const hit = judgeLotteryBet('pl5', single.numbers, draw)
  assert.equal(hit.status, 'won')
  assert.equal(hit.tier, '一等奖')
  assert.equal(hit.winningUnits, 1)

  const complexHit = judgeLotteryBet('pl5', complex.numbers, draw)
  assert.equal(complexHit.status, 'won')
  assert.equal(complexHit.winningUnits, 1)

  const miss = judgeLotteryBet('pl5', { main: [[1], [5], [4], [4], [9]] }, draw)
  assert.equal(miss.status, 'lost')
  assert.equal(miss.hits.main, 4)

  // 旧数据（扁平数组）仍能判定
  const legacy = judgeLotteryBet('pl5', { main: [1, 5, 4, 4, 8], extra: [] }, draw)
  assert.equal(legacy.status, 'won')

  assert.throws(() => normalizeLotteryNumbers('pl5', { main: [1, 5, 4, 4, 8] }), /按 5 个位次选号/)
  assert.throws(() => normalizeLotteryNumbers('pl5', { main: [[1], [], [4], [4], [8]] }), /第 2 位至少要选/)
})

test('七星彩：前六位 0–9、第七位 0–14，按位判定', () => {
  const numbers = normalizeLotteryNumbers('qxc', {
    main: [[1], [2], [3], [4], [5], [6], [7]],
  })
  assert.equal(numbers.units, 1)

  // 第七位 10–14 是合法号码（官方末位 15 选 1）
  const withHighLast = normalizeLotteryNumbers('qxc', {
    main: [[1], [2], [3], [4], [5], [6], [14]],
  })
  assert.equal(withHighLast.numbers.main[6][0], 14)

  const won = judgeLotteryBet('qxc', numbers.numbers, {
    issue: '26100',
    draw_date: '2026-10-29',
    main_numbers: [1, 2, 3, 4, 5, 6, 7],
    extra_numbers: [],
  })
  assert.equal(won.status, 'won')
  assert.equal(won.winningUnits, 1)

  const wonHigh = judgeLotteryBet('qxc', withHighLast.numbers, {
    issue: '26101',
    draw_date: '2026-10-30',
    main_numbers: [1, 2, 3, 4, 5, 6, 12],
    extra_numbers: [],
  })
  assert.equal(wonHigh.status, 'lost')
  assert.equal(wonHigh.hits.main, 6)

  const lost = judgeLotteryBet('qxc', numbers.numbers, {
    issue: '26102',
    draw_date: '2026-10-31',
    main_numbers: [1, 2, 3, 4, 5, 6, 9],
    extra_numbers: [],
  })
  assert.equal(lost.status, 'lost')
  assert.equal(lost.hits.main, 6)

  assert.throws(() => normalizeLotteryNumbers('qxc', { main: [[10], [2], [3], [4], [5], [6], [7]] }), /第 1 位号码必须是 0–9/)
  assert.throws(() => normalizeLotteryNumbers('qxc', { main: [[1], [2], [3], [4], [5], [6], [15]] }), /第 7 位号码必须是 0–14/)
})

test('大乐透：单式 1 注、复式 C(n,5)×C(k,2)、九个奖级', () => {
  const single = normalizeLotteryNumbers('dlt', {
    main: [32, 1, 6, 10, 15],
    extra: [8, 3],
  })
  assert.deepEqual(single.numbers, { main: [1, 6, 10, 15, 32], extra: [3, 8] })
  assert.equal(single.units, 1)

  const complex = normalizeLotteryNumbers('dlt', {
    main: [1, 6, 10, 15, 32, 33],
    extra: [3, 8, 9],
  })
  assert.equal(complex.units, 6 * 3)

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
    assert.equal(judged.winningUnits, 1)
  }

  // 复式：前区 6 个（含 5 个开奖号）+ 后区 3 个（含 2 个开奖号），共 18 注
  const complexJudge = judgeLotteryBet('dlt', complex.numbers, draw)
  assert.equal(complexJudge.status, 'won')
  const tierMap = Object.fromEntries(complexJudge.tiers.map((item) => [item.tier, item.units]))
  assert.equal(tierMap['一等奖'], 1) // 5+2
  assert.equal(tierMap['二等奖'], 2) // 5+1：后区多出的 9 换掉 3 或 8
  assert.equal(tierMap['四等奖'], 5) // 4+2：前区多出的 33 换掉一个开奖号
  assert.equal(tierMap['五等奖'], 10) // 4+1
  assert.equal(complexJudge.winningUnits, 1 + 2 + 5 + 10)

  const lost = judgeLotteryBet('dlt', { main: [2, 7, 11, 16, 33], extra: [9, 10] }, draw)
  assert.equal(lost.status, 'lost')
  assert.equal(lost.winningUnits, 0)

  assert.throws(
    () => normalizeLotteryNumbers('dlt', { main: [1, 1, 6, 10, 15], extra: [3, 8] }),
    /不能重复/,
  )
  assert.throws(() => normalizeLotteryNumbers('dlt', { main: [1, 6, 10, 15, 36], extra: [3, 8] }), /1–35/)
  assert.throws(() => normalizeLotteryNumbers('dlt', { main: [1, 6, 10, 15], extra: [3, 8] }), /至少选 5 个/)
})

test('没有开奖时一律 pending', () => {
  const judged = judgeLotteryBet('pl5', { main: [[1], [2], [3], [4], [5]], extra: [] }, null)
  assert.equal(judged.status, 'pending')
  assert.equal(judged.draw, null)
})
