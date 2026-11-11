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
  assert.equal(resolveLotteryGame('ssq')?.name, '双色球')
  assert.equal(resolveLotteryGame('kl8')?.name, '快乐8')
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

test('双色球：单式 6+1、复式注数与六个奖级', () => {
  const single = normalizeLotteryNumbers('ssq', {
    main: [30, 3, 9, 16, 20, 25],
    extra: [5],
  })
  assert.deepEqual(single.numbers, {
    main: [3, 9, 16, 20, 25, 30],
    extra: [5],
  })
  assert.equal(single.units, 1)
  assert.equal(single.mode, 'single')

  const blueComplex = normalizeLotteryNumbers('ssq', {
    main: [3, 9, 16, 20, 25, 30],
    extra: [5, 11],
  })
  assert.equal(blueComplex.units, 2)
  assert.equal(blueComplex.mode, 'multiple')

  const redComplex = normalizeLotteryNumbers('ssq', {
    main: [3, 9, 16, 20, 25, 30, 31],
    extra: [5],
  })
  assert.equal(redComplex.units, 7)

  const draw = {
    issue: '2026129',
    draw_date: '2026-11-10',
    main_numbers: [3, 9, 16, 20, 25, 30],
    extra_numbers: [5],
  }

  const first = judgeLotteryBet('ssq', single.numbers, draw)
  assert.equal(first.status, 'won')
  assert.equal(first.tier, '一等奖')
  assert.equal(first.winningUnits, 1)
  assert.deepEqual(first.hits, { main: 6, extra: 1 })

  const blueTwo = judgeLotteryBet('ssq', blueComplex.numbers, draw)
  assert.equal(blueTwo.status, 'won')
  assert.equal(blueTwo.winningUnits, 2)
  assert.deepEqual(
    Object.fromEntries(blueTwo.tiers.map((item) => [item.tier, item.units])),
    { 一等奖: 1, 二等奖: 1 },
  )

  const redSeven = judgeLotteryBet('ssq', redComplex.numbers, draw)
  assert.equal(redSeven.status, 'won')
  assert.equal(redSeven.winningUnits, 7)
  assert.deepEqual(
    Object.fromEntries(redSeven.tiers.map((item) => [item.tier, item.units])),
    { 一等奖: 1, 三等奖: 6 },
  )

  const fivePlusBlue = judgeLotteryBet('ssq', { main: [3, 9, 16, 20, 25, 31], extra: [5] }, draw)
  assert.equal(fivePlusBlue.tier, '三等奖')
  assert.equal(fivePlusBlue.winningUnits, 1)

  assert.throws(
    () => normalizeLotteryNumbers('ssq', { main: [1, 2, 3, 4, 5], extra: [1] }),
    /至少选 6 个/,
  )
  assert.throws(
    () => normalizeLotteryNumbers('ssq', { main: [1, 2, 3, 4, 5, 6], extra: [] }),
    /至少选 1 个/,
  )
  assert.throws(
    () => normalizeLotteryNumbers('ssq', { main: [1, 2, 3, 4, 5, 34], extra: [1] }),
    /1–33/,
  )
  assert.throws(
    () => normalizeLotteryNumbers('ssq', { main: [1, 2, 3, 4, 5, 5], extra: [1] }),
    /不能重复/,
  )
})

test('快乐8：选十固定 10 个号码，按选十奖级判定', () => {
  const single = normalizeLotteryNumbers('kl8', {
    main: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  })
  assert.equal(single.units, 1)
  assert.equal(single.mode, 'single')

  const draw = {
    issue: '2026300',
    draw_date: '2026-11-10',
    main_numbers: Array.from({ length: 20 }, (_, index) => index + 1),
    extra_numbers: [],
  }

  const top = judgeLotteryBet('kl8', single.numbers, draw)
  assert.equal(top.status, 'won')
  assert.equal(top.tier, '选十中十')
  assert.equal(top.hits.main, 10)

  const zero = judgeLotteryBet(
    'kl8',
    { main: [61, 62, 63, 64, 65, 66, 67, 68, 69, 70] },
    draw,
  )
  assert.equal(zero.status, 'won')
  assert.equal(zero.tier, '选十中零')

  const miss = judgeLotteryBet(
    'kl8',
    { main: [1, 2, 3, 4, 21, 22, 23, 24, 25, 26] },
    draw,
  )
  assert.equal(miss.status, 'lost')
  assert.equal(miss.hits.main, 4)

  assert.throws(
    () => normalizeLotteryNumbers('kl8', { main: [1, 2, 3, 4, 5, 6, 7, 8, 9] }),
    /正好选 10 个/,
  )
  assert.throws(
    () => normalizeLotteryNumbers('kl8', { main: [1, 2, 3, 4, 5, 6, 7, 8, 9, 81] }),
    /1–80/,
  )
})

test('没有开奖时一律 pending', () => {
  const judged = judgeLotteryBet('pl5', { main: [[1], [2], [3], [4], [5]], extra: [] }, null)
  assert.equal(judged.status, 'pending')
  assert.equal(judged.draw, null)
})
