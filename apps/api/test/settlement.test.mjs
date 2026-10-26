import assert from 'node:assert/strict'
import test from 'node:test'

import { computePlanMetrics, legOutcome, parsePassType, settleBet } from '../src/settlement.mjs'

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

test('parsePassType: 只认 n串1', () => {
  assert.equal(parsePassType('2串1'), 2)
  assert.equal(parsePassType('8串1'), 8)
  assert.equal(parsePassType('单关'), 0)
  assert.equal(parsePassType(''), 0)
})

test('computePlanMetrics: 2 场复式 2×1 = 2 注，最高奖金按每场最大赔率连乘', () => {
  const metrics = computePlanMetrics({
    groups: [
      { optionCount: 2, maxOdds: 3 },
      { optionCount: 1, maxOdds: 2 },
    ],
    passTypes: ['2串1'],
    multiple: 1,
  })
  assert.equal(metrics.units, 2)
  assert.equal(metrics.amount, 4)
  assert.equal(metrics.maxBonus, 12)
})

test('computePlanMetrics: 多个过关方式累加', () => {
  const metrics = computePlanMetrics({
    groups: [
      { optionCount: 1, maxOdds: 2 },
      { optionCount: 1, maxOdds: 2 },
      { optionCount: 1, maxOdds: 2 },
    ],
    passTypes: ['2串1', '3串1'],
    multiple: 2,
  })
  assert.equal(metrics.units, 3 + 1)
  assert.equal(metrics.amount, 4 * 2 * 2)
  assert.equal(metrics.maxBonus, (4 * 3 + 8) * 2 * 2)
})

test('legOutcome: 胜平负 / 让球 / 总进球 / 比分 / 半全场', () => {
  assert.equal(legOutcome({ pool: 'had', optionKey: 'h' }, result()), 'won')
  assert.equal(legOutcome({ pool: 'had', optionKey: 'a' }, result()), 'lost')
  // 2 - 1 + (-1) = 0 < 1 → 让球负？ 2:1 让一球后 1:1 → 平
  assert.equal(legOutcome({ pool: 'hhad', optionKey: 'rq-d', goalLine: -1 }, result()), 'won')
  assert.equal(legOutcome({ pool: 'hhad', optionKey: 'rq-h', goalLine: -1 }, result()), 'lost')
  // 让两球后 0:1 → 让球负
  assert.equal(legOutcome({ pool: 'hhad', optionKey: 'rq-a', goalLine: -2 }, result()), 'won')
  assert.equal(legOutcome({ pool: 'ttg', optionKey: 's3' }, result()), 'won')
  assert.equal(legOutcome({ pool: 'ttg', optionKey: 's2' }, result()), 'lost')
  assert.equal(legOutcome({ pool: 'crs', optionKey: 's02s01' }, result()), 'won')
  assert.equal(legOutcome({ pool: 'hafu', optionKey: 'hh' }, result()), 'won')
  assert.equal(legOutcome({ pool: 'hafu', optionKey: 'dh' }, result()), 'lost')
})

test('legOutcome: 没有赛果一律 pending', () => {
  assert.equal(legOutcome({ pool: 'had', optionKey: 'h' }, null), 'pending')
  assert.equal(legOutcome({ pool: 'had', optionKey: 'h' }, result({ settled: false, had: null })), 'pending')
  assert.equal(legOutcome({ pool: 'ttg', optionKey: 's3' }, result({ ttg: null })), 'pending')
})

test('settleBet: 2串1 全中，按赔率连乘 × 2 × 倍数', () => {
  const { status, payout, passTypeDetails } = settleBet({
    bet: { passTypes: ['2串1'], multiple: 2 },
    legs: [
      { id: '1', sportteryMatchId: 1, pool: 'had', optionKey: 'h', odds: 2.5 },
      { id: '2', sportteryMatchId: 2, pool: 'had', optionKey: 'h', odds: 1.8 },
    ],
    results: new Map([
      [1, result()],
      [2, result()],
    ]),
  })

  assert.equal(status, 'won')
  assert.equal(payout, 2 * 2 * 2.5 * 1.8)
  assert.equal(passTypeDetails[0].wonUnits, 1)
})

test('settleBet: 有一场没开奖 → pending，不提前判负', () => {
  const { status, payout } = settleBet({
    bet: { passTypes: ['2串1'], multiple: 1 },
    legs: [
      { id: '1', sportteryMatchId: 1, pool: 'had', optionKey: 'h', odds: 2.5 },
      { id: '2', sportteryMatchId: 2, pool: 'had', optionKey: 'h', odds: 1.8 },
    ],
    results: new Map([
      [1, result()],
      [2, { settled: false }],
    ]),
  })

  assert.equal(status, 'pending')
  assert.equal(payout, 0)
})

test('settleBet: 复式里只有一个选项命中，只赔命中的那一注', () => {
  const { status, payout } = settleBet({
    bet: { passTypes: ['2串1'], multiple: 1 },
    legs: [
      { id: '1', sportteryMatchId: 1, pool: 'had', optionKey: 'h', odds: 2.5 },
      { id: '2', sportteryMatchId: 1, pool: 'had', optionKey: 'd', odds: 3.2 },
      { id: '3', sportteryMatchId: 2, pool: 'had', optionKey: 'h', odds: 1.8 },
    ],
    results: new Map([
      [1, result()],
      [2, result()],
    ]),
  })

  assert.equal(status, 'won')
  // 只算命中选项 h 的赔率 2.5 × 1.8，d 的那一注不中
  assert.equal(payout, 2 * 2.5 * 1.8)
})

test('settleBet: 全灭 → lost', () => {
  const { status, payout } = settleBet({
    bet: { passTypes: ['2串1'], multiple: 1 },
    legs: [
      { id: '1', sportteryMatchId: 1, pool: 'had', optionKey: 'a', odds: 3 },
      { id: '2', sportteryMatchId: 2, pool: 'had', optionKey: 'a', odds: 3 },
    ],
    results: new Map([
      [1, result()],
      [2, result()],
    ]),
  })

  assert.equal(status, 'lost')
  assert.equal(payout, 0)
})

test('settleBet: 比分「胜其它」也能中', () => {
  const { status, payout } = settleBet({
    bet: { passTypes: ['2串1'], multiple: 1 },
    legs: [
      { id: '1', sportteryMatchId: 1, pool: 'crs', optionKey: 's1sh', odds: 12 },
      { id: '2', sportteryMatchId: 2, pool: 'hafu', optionKey: 'hh', odds: 3.4 },
    ],
    results: new Map([
      [1, result({ homeScore: 6, awayScore: 0, had: 'h', crs: 's1sh' })],
      [2, result()],
    ]),
  })

  assert.equal(status, 'won')
  assert.equal(payout, 2 * 12 * 3.4)
})

test('computePlanMetrics: 4串1 单注封顶 50 万 × 倍数', () => {
  const metrics = computePlanMetrics({
    groups: Array.from({ length: 4 }, () => ({ optionCount: 1, maxOdds: 100 })),
    passTypes: ['4串1'],
    multiple: 2,
  })
  assert.equal(metrics.units, 1)
  assert.equal(metrics.amount, 4)
  // 2 × 100^4 = 2 亿 → 单注封顶 50 万，2 倍 = 100 万
  assert.equal(metrics.maxBonus, 1_000_000)
})

test('computePlanMetrics: 6串1 单注封顶 100 万', () => {
  const metrics = computePlanMetrics({
    groups: Array.from({ length: 6 }, () => ({ optionCount: 1, maxOdds: 100 })),
    passTypes: ['6串1'],
    multiple: 1,
  })
  assert.equal(metrics.maxBonus, 1_000_000)
})

test('computePlanMetrics: 2串1 高于 20 万时按 20 万封顶', () => {
  const metrics = computePlanMetrics({
    groups: [
      { optionCount: 1, maxOdds: 400 },
      { optionCount: 1, maxOdds: 400 },
    ],
    passTypes: ['2串1'],
    multiple: 1,
  })
  // 2 × 400 × 400 = 32 万 → 单注上限 20 万
  assert.equal(metrics.maxBonus, 200_000)
})

test('computePlanMetrics: 未超过限额不封顶', () => {
  const metrics = computePlanMetrics({
    groups: [
      { optionCount: 1, maxOdds: 3 },
      { optionCount: 1, maxOdds: 2 },
    ],
    passTypes: ['2串1'],
    multiple: 3,
  })
  assert.equal(metrics.maxBonus, 2 * 3 * 2 * 3)
})

test('settleBet: 中奖奖金按单注限额封顶', () => {
  const legs = Array.from({ length: 4 }, (_, index) => ({
    id: String(index + 1),
    sportteryMatchId: index + 1,
    pool: 'had',
    optionKey: 'h',
    odds: 100,
  }))
  const { status, payout } = settleBet({
    bet: { passTypes: ['4串1'], multiple: 2 },
    legs,
    results: new Map(legs.map((leg) => [leg.sportteryMatchId, result()])),
  })
  assert.equal(status, 'won')
  // 2 × 100^4 × 2 = 4 亿 → 单注 50 万 × 2 倍 = 100 万
  assert.equal(payout, 1_000_000)
})

test('settleBet: 2串1 中奖奖金封顶 20 万', () => {
  const { payout } = settleBet({
    bet: { passTypes: ['2串1'], multiple: 1 },
    legs: [
      { id: '1', sportteryMatchId: 1, pool: 'had', optionKey: 'h', odds: 400 },
      { id: '2', sportteryMatchId: 2, pool: 'had', optionKey: 'h', odds: 400 },
    ],
    results: new Map([
      [1, result()],
      [2, result()],
    ]),
  })
  assert.equal(payout, 200_000)
})
