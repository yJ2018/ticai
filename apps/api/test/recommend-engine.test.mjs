import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRecommendation } from '../src/recommend/engine.mjs'

/**
 * 推荐引擎的风控口径（纯函数）。
 *
 * 这一组用例守的是「不要瞎来」：赔率上限、串关长度、命中率下限、长赔不入方案、
 * 没数据时不伪造优势。真实数据每次都在变，所以这里只用固定夹具。
 */

const TTG = [12, 4.8, 3.4, 3.6, 5.2, 9, 15, 22]

function makeOdds({ had, hhad, ttg = TTG, line = '' }) {
  return {
    had: { h: String(had[0]), d: String(had[1]), a: String(had[2]) },
    hhad: {
      h: String(hhad[0]),
      d: String(hhad[1]),
      a: String(hhad[2]),
      goalLine: line,
      goalLineValue: line,
    },
    ttg: Object.fromEntries(ttg.map((value, index) => [`s${index}`, String(value)])),
  }
}

function makeMatch(id, odds, overrides = {}) {
  return {
    matchId: id,
    matchNo: `周四00${id % 10}`,
    league: overrides.league ?? `联赛${id}`,
    homeName: `主队${id}`,
    awayName: `客队${id}`,
    kickoffAt: '2026-10-29T11:00:00.000Z',
    businessDate: overrides.businessDate ?? '2026-10-29',
    homeTeamId: id * 10,
    awayTeamId: id * 10 + 1,
    odds: odds ?? null,
    oddsCapturedAt: '2026-10-29T09:00:00.000Z',
    ...overrides,
  }
}

const NOW = new Date('2026-10-29T08:00:00+08:00')

/** 强热门：主胜 1.35，胜平负去水后约 72%。 */
const favouriteOdds = () => makeOdds({ had: [1.35, 4.8, 8.0], hhad: [2.1, 3.4, 3.2], line: '+1' })

test('强热门才进方案：串关长度、赔率上限、命中率下限都有硬约束', () => {
  const slate = [1, 2, 3, 4].map((id) => makeMatch(id, favouriteOdds()))
  const data = buildRecommendation({ slate, finished: [], pool: 'had', scope: 'today', now: NOW })

  assert.ok(data.plans.length > 0, '有合格场次时应出方案')

  for (const plan of data.plans) {
    assert.ok(plan.legs.length <= 3, '最多 3 场')
    assert.ok(plan.totalOdd <= 8.01, `总赔率应 ≤ 8，实际 ${plan.totalOdd}`)
    for (const leg of plan.legs) {
      assert.ok(leg.odd >= 1.2 && leg.odd <= 3.61, `单腿赔率越界：${leg.odd}`)
      assert.ok(leg.blendP >= 0.4, `单腿融合概率太低：${leg.blendP}`)
      assert.ok(leg.marketP >= 0.26, `单腿市场概率太低：${leg.marketP}`)
      assert.ok(Number.isFinite(leg.modelP) && leg.modelP > 0)
    }
    if (plan.id === 'safe') {
      assert.equal(plan.legs.length, 2, '稳健方案固定 2 串 1')
      assert.ok(plan.hitProb >= 0.26, `2串1 命中率下限：${plan.hitProb}`)
    }
    if (plan.id === 'aggressive') {
      assert.equal(plan.legs.length, 3, '进取方案固定 3 串 1')
      assert.ok(plan.hitProb >= 0.15)
    }
    assert.ok(plan.hitProb * plan.totalOdd < 1.2, '不应出现「期望明显 > 1」的假优势')
  }
})

test('长赔（22.00 这类冷门）永远不进推荐，即使它是拟合残差最大的一项', () => {
  const longshotOdds = makeOdds({ had: [1.28, 5.2, 11.0], hhad: [2.3, 3.3, 3.1], line: '+1' })
  const slate = [1, 2, 3].map((id) => makeMatch(id, longshotOdds))
  const data = buildRecommendation({ slate, finished: [], pool: 'mixed', scope: 'today', now: NOW })

  for (const plan of data.plans) {
    for (const leg of plan.legs) {
      assert.ok(leg.odd <= 3.6, `长赔混进了方案：${leg.optionLabel} @${leg.odd}`)
    }
  }
  for (const candidate of data.candidates) {
    assert.ok(candidate.odd <= 11.01)
  }
})

test('数据不足时不伪造优势：融合概率贴近市场，edge 不为正', () => {
  const slate = [1, 2].map((id) => makeMatch(id, favouriteOdds()))
  const data = buildRecommendation({ slate, finished: [], pool: 'had', scope: 'today', now: NOW })

  for (const plan of data.plans) {
    for (const leg of plan.legs) {
      assert.ok(leg.weight <= 0.05, `没有近况/伤停时模型权重应接近 0，实际 ${leg.weight}`)
      assert.ok(Math.abs(leg.blendP - leg.marketP) < 0.005, '融合概率应贴近市场')
      assert.ok(leg.edge < 0, '没有数据时不应出现正期望')
    }
  }
})

test('达不到门槛就空着：1.15 的热门不推', () => {
  const odds = makeOdds({ had: [1.15, 7.5, 15], hhad: [1.4, 4.6, 6.2], line: '+1' })
  const slate = [1, 2, 3].map((id) => makeMatch(id, odds))
  const data = buildRecommendation({ slate, finished: [], pool: 'had', scope: 'today', now: NOW })

  assert.equal(data.plans.length, 0, '低于最低赔率的场次不应硬凑方案')
  assert.ok(data.notes.some((note) => note.includes('没有达到门槛')))
})

test('今天口径：business_date 不是今天的场次不参与', () => {
  const today = [makeMatch(1, favouriteOdds()), makeMatch(2, favouriteOdds())]
  const tomorrow = [makeMatch(3, favouriteOdds(), { businessDate: '2026-10-30' })]
  const data = buildRecommendation({
    slate: [...today, ...tomorrow],
    finished: [],
    pool: 'had',
    scope: 'today',
    now: NOW,
  })

  assert.equal(data.coverage.inScope, 2)
  const ids = data.plans.flatMap((plan) => plan.legs.map((leg) => leg.matchId))
  assert.ok(!ids.includes(3), '跨天场次不应进今天方案')
})

test('近况与伤停只做有界修正：λ 最多 ±30%', () => {
  const slate = [makeMatch(1, favouriteOdds(), { homeTeamId: 10, awayTeamId: 11 })]
  const injuries = new Map([
    [1, { home: { count: 9, names: ['A', 'B'] }, away: { count: 0, names: [] } }],
  ])
  const finished = [
    // 主队两连胜且大比分，客队两连败
    ...Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      matchId: 100 + index,
      kickoffAt: `2026-10-2${index}T11:00:00.000Z`,
      homeTeamId: 10,
      awayTeamId: 999,
      homeScore: 3,
      awayScore: 0,
    })),
  ]
  const data = buildRecommendation({ slate, injuries, finished, pool: 'had', scope: 'today', now: NOW })

  assert.ok(data.candidates.length > 0)
  const leg = data.candidates[0]
  assert.ok(leg.weight <= 0.42, `融合权重上限 0.42，实际 ${leg.weight}`)
  assert.ok(leg.reasons.some((reason) => reason.includes('伤停')))
  assert.ok(leg.reasons.some((reason) => reason.includes('近 6 场')))
})

test('比分/半全场不参与推荐（方差太大），并给出说明', () => {
  const slate = [makeMatch(1, favouriteOdds())]
  const data = buildRecommendation({ slate, finished: [], pool: 'crs', scope: 'today', now: NOW })

  assert.equal(data.plans.length, 0)
  assert.ok(data.notes.some((note) => note.includes('比分')))
})
