import assert from 'node:assert/strict'
import test from 'node:test'

import { goalLineOf, oddsKeyOf, pickClosingOdds } from '../src/closing-odds.mjs'
import { settleBet } from '../src/settlement.mjs'

/**
 * 开奖赔率（停售前最后一份官方赔率）提取 + 「票面 vs 开奖」奖金对比。
 *
 * 赔率对象结构取自真实快照：{had:{h,d,a}, hhad:{h,d,a,goalLine}, ttg:{s0..s7}, crs:{...}, hafu:{...}}，
 * 值都是字符串，另外还带一堆 `*f` 标记和 updateDate/updateTime。
 */
const odds = {
  had: { h: '2.57', d: '3.45', a: '2.17', hf: '0', updateDate: '2026-10-31' },
  hhad: { h: '1.49', d: '4.05', a: '4.52', goalLine: '+1', goalLineValue: '+1.00' },
  ttg: { s0: '27.00', s1: '9.25', s2: '5.05', s3: '3.60', s7: '10.00' },
  crs: { s02s01: '7.00', s1sh: '16.00', s02s01f: '0' },
  hafu: { hh: '2.50', hd: '15.00', aa: '7.75', id: 0 },
}

const result = (patch = {}) => ({
  settled: true,
  homeScore: 2,
  awayScore: 1,
  homeHalfScore: 1,
  awayHalfScore: 0,
  goalLine: -1,
  had: 'h',
  hhad: 'd',
  ttg: 3,
  crs: 's02s01',
  hafu: 'hh',
  ...patch,
})

test('oddsKeyOf: 只有让球玩法去 rq- 前缀', () => {
  assert.equal(oddsKeyOf('hhad', 'rq-h'), 'h')
  assert.equal(oddsKeyOf('had', 'h'), 'h')
  assert.equal(oddsKeyOf('crs', 's02s01'), 's02s01')
})

test('goalLineOf: "+1" / "-2" / 空串', () => {
  assert.equal(goalLineOf(odds), 1)
  assert.equal(goalLineOf({ hhad: { goalLine: '-2' } }), -2)
  assert.equal(goalLineOf({ hhad: { goalLine: '' } }), null)
  assert.equal(goalLineOf({}), null)
})

test('pickClosingOdds: 五个玩法都能按 optionKey 取到', () => {
  assert.equal(pickClosingOdds(odds, 'had', 'h'), 2.57)
  assert.equal(pickClosingOdds(odds, 'hhad', 'rq-d', 1), 4.05)
  assert.equal(pickClosingOdds(odds, 'ttg', 's3'), 3.6)
  assert.equal(pickClosingOdds(odds, 'crs', 's02s01'), 7)
  assert.equal(pickClosingOdds(odds, 'hafu', 'hh'), 2.5)
})

test('pickClosingOdds: 让球盘口变过就不比，宁缺勿错', () => {
  assert.equal(pickClosingOdds(odds, 'hhad', 'rq-h', -1), null)
  // 下注时没记让球数（老数据）时不做盘口校验，仍然取该档赔率
  assert.equal(pickClosingOdds(odds, 'hhad', 'rq-h', null), 1.49)
})

test('pickClosingOdds: 缺失 / 0 / 非数字一律 null', () => {
  assert.equal(pickClosingOdds(odds, 'had', 'x'), null)
  assert.equal(pickClosingOdds({ had: { h: '0' } }, 'had', 'h'), null)
  assert.equal(pickClosingOdds({ had: { h: '--' } }, 'had', 'h'), null)
  assert.equal(pickClosingOdds({}, 'had', 'h'), null)
  assert.equal(pickClosingOdds(null, 'had', 'h'), null)
  assert.equal(pickClosingOdds(odds, 'nope', 'h'), null)
})

test('settleBet: 按开奖赔率重算奖金并给出差额', () => {
  const { payout, closing } = settleBet({
    bet: { passTypes: ['2串1'], multiple: 1 },
    legs: [
      { id: '1', sportteryMatchId: 1, pool: 'had', optionKey: 'h', odds: 2.5, closingOdds: 2.8 },
      { id: '2', sportteryMatchId: 2, pool: 'had', optionKey: 'h', odds: 4, closingOdds: 3.5 },
    ],
    results: new Map([
      [1, result()],
      [2, result()],
    ]),
  })

  assert.equal(payout, 2 * 2.5 * 4)
  assert.equal(closing.payout, Number((2 * 2.8 * 3.5).toFixed(2)))
  assert.equal(closing.diff, Number((2 * 2.8 * 3.5 - 2 * 2.5 * 4).toFixed(2)))
  assert.equal(closing.complete, true)
})

test('settleBet: 开奖赔率同样按单注限额封顶', () => {
  const legs = Array.from({ length: 4 }, (_, index) => ({
    id: String(index + 1),
    sportteryMatchId: index + 1,
    pool: 'had',
    optionKey: 'h',
    odds: 100,
    closingOdds: 120,
  }))
  const { payout, closing } = settleBet({
    bet: { passTypes: ['4串1'], multiple: 2 },
    legs,
    results: new Map(legs.map((leg) => [leg.sportteryMatchId, result()])),
  })
  // 票面与开奖都封顶 50 万，2 倍 → 100 万
  assert.equal(payout, 1_000_000)
  assert.equal(closing.payout, 1_000_000)
  assert.equal(closing.diff, 0)
})

test('settleBet: 命中组合缺开奖赔率 → 不给对比金额', () => {
  const { payout, closing } = settleBet({
    bet: { passTypes: ['2串1'], multiple: 1 },
    legs: [
      { id: '1', sportteryMatchId: 1, pool: 'had', optionKey: 'h', odds: 2.5, closingOdds: 2.8 },
      { id: '2', sportteryMatchId: 2, pool: 'had', optionKey: 'h', odds: 1.8, closingOdds: null },
    ],
    results: new Map([
      [1, result()],
      [2, result()],
    ]),
  })

  assert.equal(payout, 2 * 2.5 * 1.8)
  assert.equal(closing.payout, null)
  assert.equal(closing.diff, null)
  assert.equal(closing.complete, false)
})

test('settleBet: 还没开完奖不给对比金额', () => {
  const { status, closing } = settleBet({
    bet: { passTypes: ['2串1'], multiple: 1 },
    legs: [
      { id: '1', sportteryMatchId: 1, pool: 'had', optionKey: 'h', odds: 2.5, closingOdds: 2.8 },
      { id: '2', sportteryMatchId: 2, pool: 'had', optionKey: 'h', odds: 1.8, closingOdds: 2.0 },
    ],
    results: new Map([
      [1, result()],
      [2, { settled: false }],
    ]),
  })

  assert.equal(status, 'pending')
  assert.equal(closing.payout, null)
  assert.equal(closing.complete, true)
})

test('settleBet: 全灭时对比金额是 0，不因为缺赔率变成 null', () => {
  const { status, payout, closing } = settleBet({
    bet: { passTypes: ['2串1'], multiple: 1 },
    legs: [
      { id: '1', sportteryMatchId: 1, pool: 'had', optionKey: 'a', odds: 3, closingOdds: 3.2 },
      { id: '2', sportteryMatchId: 2, pool: 'had', optionKey: 'a', odds: 3, closingOdds: 3.2 },
    ],
    results: new Map([
      [1, result()],
      [2, result()],
    ]),
  })

  assert.equal(status, 'lost')
  assert.equal(payout, 0)
  assert.equal(closing.payout, 0)
  assert.equal(closing.diff, 0)
})

test('settleBet: 每条腿把开奖赔率与快照时间原样带出去', () => {
  const { legs } = settleBet({
    bet: { passTypes: ['2串1'], multiple: 1 },
    legs: [
      {
        id: '1',
        sportteryMatchId: 1,
        pool: 'had',
        optionKey: 'h',
        odds: 2.5,
        closingOdds: 2.8,
        closingOddsAt: '2026-10-30T13:36:17.091Z',
      },
    ],
    results: new Map([[1, result()]]),
  })

  assert.equal(legs[0].closingOdds, 2.8)
  assert.equal(legs[0].closingOddsAt, '2026-10-30T13:36:17.091Z')
})
