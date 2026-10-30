import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMatchSignals } from '../src/recommend/engine.mjs'
import { CLOSE_ODDS_GAP, buildCloseSignals } from '../src/recommend/signals.mjs'

/**
 * 投注页「赔率接近」标注的口径：
 *   - 只看同一玩法赔率最低的两个选项；
 *   - 相对差 ≤ 8% 才标；
 *   - 谁更被看好由融合概率（市场 + 近况/伤停）决定，不是简单取低赔；
 *   - 总进球用「2球 / 3球」，让球用「让胜 / 让负」。
 */

function candidate(overrides = {}) {
  return {
    matchId: 1,
    matchNo: '周五001',
    teams: '主队 vs 客队',
    pool: 'ttg',
    poolLabel: '总进球',
    optionKey: 's2',
    optionLabel: '总进球 2',
    odd: 3.4,
    marketP: 0.25,
    modelP: 0.25,
    blendP: 0.25,
    sample: { homeMatches: 4, awayMatches: 4 },
    goalExpectation: {
      expectedTotal: 2.8,
      marketTotal: 2.9,
      homeMatches: 4,
      awayMatches: 4,
    },
    ...overrides,
  }
}

test('最低两档接近时标两个选项，模型偏向融合概率更高的那个', () => {
  const signals = buildCloseSignals([
    candidate({ optionKey: 's2', optionLabel: '总进球 2', odd: 3.4, blendP: 0.26 }),
    candidate({ optionKey: 's3', optionLabel: '总进球 3', odd: 3.5, blendP: 0.29 }),
    candidate({ optionKey: 's4', optionLabel: '总进球 4', odd: 5.0, blendP: 0.12 }),
  ])

  assert.equal(signals.length, 1)
  const signal = signals[0]
  assert.equal(signal.gap, 0.0294)
  assert.deepEqual(
    signal.options.map((item) => item.optionKey),
    ['s2', 's3'],
  )
  assert.equal(signal.options[0].preferred, false)
  assert.equal(signal.options[1].preferred, true)
  assert.match(signal.note, /2球 \/ 3球 赔率接近/)
  assert.match(signal.note, /期望总进球 2\.8/)
  assert.match(signal.note, /模型偏向 3球/)
})

test('最低两档差超过阈值就不标，哪怕后面的选项更接近', () => {
  const signals = buildCloseSignals([
    candidate({ optionKey: 's0', optionLabel: '总进球 0', odd: 3.0 }),
    candidate({ optionKey: 's1', optionLabel: '总进球 1', odd: 4.0 }),
    candidate({ optionKey: 's2', optionLabel: '总进球 2', odd: 4.02 }),
  ])

  assert.equal(signals.length, 0)
  assert.ok(CLOSE_ODDS_GAP <= 0.08, '阈值不应宽到把普通赔率差也算接近')
})

test('最低两档同赔时 gap=0，融合概率决定偏向', () => {
  const signals = buildCloseSignals([
    candidate({ optionKey: 's2', odd: 3.4, blendP: 0.24 }),
    candidate({ optionKey: 's3', odd: 3.4, blendP: 0.27 }),
  ])

  assert.equal(signals.length, 1)
  assert.equal(signals[0].gap, 0)
  assert.equal(signals[0].options[1].preferred, true)
})

test('胜平负与让球分开标注，让球标签压成「让胜 / 让负」', () => {
  const signals = buildCloseSignals([
    candidate({
      pool: 'had',
      poolLabel: '胜平负',
      optionKey: 'h',
      optionLabel: '胜',
      odd: 2.4,
      blendP: 0.37,
    }),
    candidate({
      pool: 'had',
      poolLabel: '胜平负',
      optionKey: 'a',
      optionLabel: '负',
      odd: 2.45,
      blendP: 0.38,
    }),
    candidate({
      pool: 'hhad',
      poolLabel: '让球胜平负',
      optionKey: 'rq-h',
      optionLabel: '让球(-1) 胜',
      odd: 3.1,
      blendP: 0.31,
    }),
    candidate({
      pool: 'hhad',
      poolLabel: '让球胜平负',
      optionKey: 'rq-d',
      optionLabel: '让球(-1) 平',
      odd: 3.15,
      blendP: 0.3,
    }),
  ])

  const had = signals.find((item) => item.pool === 'had')
  const hhad = signals.find((item) => item.pool === 'hhad')
  assert.ok(had)
  assert.ok(hhad)
  assert.deepEqual(
    hhad.options.map((item) => item.optionLabel),
    ['让胜', '让平'],
  )
  assert.match(hhad.note, /让胜 \/ 让平 赔率接近/)
  assert.equal(had.goalExpectation, undefined)
})

test('缺项或非法赔率不产生信号', () => {
  assert.equal(buildCloseSignals([]).length, 0)
  assert.equal(buildCloseSignals([candidate()]).length, 0)
  assert.equal(
    buildCloseSignals([
      candidate({ optionKey: 's0', odd: 0 }),
      candidate({ optionKey: 's1', odd: 3.5 }),
    ]).length,
    0,
  )
})

function makeOdds() {
  return {
    had: { h: '2.60', d: '3.30', a: '2.50' },
    hhad: { h: '2.10', d: '3.40', a: '3.20', goalLine: '-1', goalLineValue: '-1' },
    ttg: Object.fromEntries(
      [12, 4.8, 3.4, 3.6, 5.2, 9, 15, 22].map((value, index) => [`s${index}`, String(value)]),
    ),
  }
}

test('buildMatchSignals：只返回标注，不返回方案，且覆盖全部在售比赛', () => {
  const data = buildMatchSignals({
    slate: [
      {
        matchId: 101,
        matchNo: '周五001',
        league: '测试联赛',
        homeName: '主队',
        awayName: '客队',
        kickoffAt: '2026-10-30T11:00:00.000Z',
        businessDate: '2026-10-30',
        homeTeamId: 1,
        awayTeamId: 2,
        odds: makeOdds(),
        oddsCapturedAt: '2026-10-30T09:00:00.000Z',
      },
    ],
    finished: [],
    pool: 'ttg',
    now: new Date('2026-10-30T08:00:00+08:00'),
  })

  assert.equal(data.scope, 'all')
  assert.equal(data.pool, 'ttg')
  assert.equal(data.plans, undefined)
  assert.equal(data.candidates, undefined)
  assert.equal(data.signals.length, 1)
  assert.deepEqual(
    data.signals[0].options.map((item) => item.optionKey),
    ['s2', 's3'],
  )
})
