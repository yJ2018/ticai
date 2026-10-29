import assert from 'node:assert/strict'
import test from 'node:test'

import { runBacktest } from '../src/recommend/backtest.mjs'

/**
 * 回测口径：只用开赛前赔率 + 赛果，按「市场概率最高且赔率在带内」选场。
 * 夹具里刻意放了命中与不中，确保命中率/回报的算法本身没写反。
 */

function sample(id, hadOdds, result, extra = {}) {
  return {
    matchId: id,
    matchDate: extra.matchDate ?? `2026-10-2${id}`,
    kickoffAt: `2026-10-2${id}T11:00:00.000Z`,
    league: '测试联赛',
    homeName: 'H',
    awayName: 'A',
    goalLine: 0,
    hadResult: result,
    hhadResult: null,
    ttgResult: null,
    fullHome: 1,
    fullAway: 0,
    odds: {
      had: { h: String(hadOdds[0]), d: String(hadOdds[1]), a: String(hadOdds[2]) },
      hhad: { h: '2.0', d: '3.3', a: '3.4', goalLine: '0' },
      ttg: { s0: '12', s1: '4.8', s2: '3.4', s3: '3.6', s4: '5.2', s5: '9', s6: '15', s7: '22' },
    },
  }
}

test('单场首选：只统计赔率带内的热门，命中率与回报按 1 单位本金算', () => {
  const data = runBacktest([
    sample(1, [1.5, 4.0, 6.0], 'h'),
    sample(2, [1.5, 4.0, 6.0], 'a'),
    sample(3, [2.0, 3.4, 3.6], 'h'),
    sample(4, [2.4, 3.2, 3.0], 'h'),
  ])

  assert.equal(data.window.matches, 4)
  assert.equal(data.singles.n, 3, '第 4 场赔率 2.4 超出稳健带，只进宽口径')
  assert.equal(data.singles.hits, 2)
  assert.equal(data.singles.hitRate, 0.6667)
  // (1.5-1) + (-1) + (2.0-1) = 0.5，除以 3 注
  assert.equal(data.singles.roi, 0.1667)

  assert.equal(data.wideSingles.n, 1)
  assert.equal(data.wideSingles.hits, 1)
})

test('2串1：相邻两两配对，任一场不中即整注输', () => {
  const data = runBacktest([
    sample(1, [1.5, 4.0, 6.0], 'h'),
    sample(2, [1.5, 4.0, 6.0], 'a'),
    sample(3, [2.0, 3.4, 3.6], 'h'),
  ])

  assert.equal(data.doubles.n, 1)
  assert.equal(data.doubles.hits, 0)
  assert.equal(data.doubles.roi, -1)
})

test('赔率区间：按选项统计命中率，长赔一定更低', () => {
  const data = runBacktest([
    sample(1, [1.5, 4.0, 6.0], 'h'),
    sample(2, [1.45, 4.4, 7.0], 'h'),
    sample(3, [1.55, 4.2, 6.5], 'h'),
    sample(4, [1.5, 4.0, 6.0], 'a'),
  ])

  const low = data.bands.find((band) => band.label === '1.25–1.60')
  const high = data.bands.find((band) => band.label === '5.00 以上')
  assert.equal(low.n, 4)
  assert.equal(high.n, 4)
  assert.ok(low.hitRate > high.hitRate, `低赔命中率应高于高赔：${low.hitRate} vs ${high.hitRate}`)
})

test('没有赛果的行不进入回测', () => {
  const broken = sample(1, [1.5, 4.0, 6.0], 'h')
  broken.hadResult = null
  const data = runBacktest([broken])
  assert.equal(data.window.matches, 0)
  assert.equal(data.singles.n, 0)
})
