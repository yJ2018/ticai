import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRecommendationHitStat,
  buildRecommendationTrack,
  evaluateRecommendationTicket,
} from '../src/analysis/recommendation-track.mjs'

/* ── 夹具：稳定的伪随机开奖，号码范围与真实玩法一致 ───────── */

function lcg(seed) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

function unique(random, count, min, max) {
  const set = new Set()
  while (set.size < count) {
    set.add(min + Math.floor(random() * (max - min + 1)))
  }
  return [...set].sort((left, right) => left - right)
}

function makeDraws(kind, count, seed = 11) {
  const random = lcg(seed)
  return Array.from({ length: count }, (_, index) => {
    const seq = 2026000 - index
    const main = kind === 'ssq' ? unique(random, 6, 1, 33) : kind === 'kl8' ? unique(random, 20, 1, 80) : unique(random, 5, 1, 35)
    const extra = kind === 'ssq' ? [1 + Math.floor(random() * 16)] : kind === 'dlt' ? unique(random, 2, 1, 12) : []
    return {
      issue: String(seq),
      issueSeq: seq,
      drawDate: new Date(Date.UTC(2026, 9, 26 - index)).toISOString().slice(0, 10),
      numbers: [...main, ...extra].map(String),
    }
  })
}

const GAMES = {
  dlt: { game_no: '85', game_key: 'dlt', name: '超级大乐透', main_count: 5, main_max: 35, extra_count: 2, extra_max: 12 },
  ssq: { game_no: 'ssq', game_key: 'ssq', name: '双色球', main_count: 6, main_max: 33, extra_count: 1, extra_max: 16 },
  kl8: { game_no: 'kl8', game_key: 'kl8', name: '快乐8', main_count: 20, main_max: 80, extra_count: 0, extra_max: null },
}

/* ── 逐期归档 ─────────────────────────────────────────────── */

for (const kind of ['dlt', 'ssq', 'kl8']) {
  test(`buildRecommendationTrack: ${kind} 每期一条，推荐/实际/命中/奖级齐全`, () => {
    const game = GAMES[kind]
    const draws = makeDraws(kind, 80)
    const track = buildRecommendationTrack(draws, { game, limit: 40 })

    assert.equal(track.kind, kind)
    assert.equal(track.items.length, 40)
    assert.equal(track.counters.samples, 40)
    assert.equal(track.recent.length, 40)

    for (const item of track.items) {
      assert.ok(item.issue)
      assert.ok(item.throughIssue)
      assert.ok(item.throughIssueSeq < item.issueSeq, '推荐只能用开奖前的数据')
      assert.ok(Array.isArray(item.actual.main))
      assert.ok(Array.isArray(item.prediction.main))
      assert.ok(Number.isInteger(item.hits.main) && item.hits.main >= 0)
      assert.ok(Number.isInteger(item.hits.extra) && item.hits.extra >= 0)
      assert.ok(item.ticket && typeof item.ticket === 'object')
      assert.ok(Array.isArray(item.ticket.tiers))
      assert.ok(Number.isInteger(item.ticket.winningUnits))
    }

    if (kind === 'dlt') {
      assert.equal(track.items[0].prediction.main.length, 5)
      assert.equal(track.items[0].prediction.extra.length, 2)
    } else if (kind === 'ssq') {
      // 双色球命中口径是 12 红池 + 4 蓝池
      assert.equal(track.items[0].prediction.main.length, 12)
      assert.equal(track.items[0].prediction.extra.length, 4)
      assert.equal(track.items[0].prediction.primaryMain.length, 6)
    } else {
      assert.equal(track.items[0].prediction.main.length, 10)
      assert.equal(track.items[0].hits.extra, 0)
    }
  })
}

test('buildRecommendationTrack: 增量续算与全量结果完全一致', () => {
  const game = GAMES.dlt
  const draws = makeDraws('dlt', 120, 23)
  const chronological = [...draws].reverse()
  const prefix = chronological.slice(0, 100).reverse()

  const prefixTrack = buildRecommendationTrack(prefix, { game, limit: 100 })
  const incremental = buildRecommendationTrack(draws, {
    game,
    limit: 120,
    sinceSeq: prefixTrack.lastTracked.issueSeq,
    counters: prefixTrack.counters,
    recent: prefixTrack.recent,
  })
  const full = buildRecommendationTrack(draws, { game, limit: 120 })

  assert.equal(incremental.items.length, 20)
  assert.deepEqual(incremental.counters, full.counters)
  assert.deepEqual(incremental.recent, full.recent)
})

test('buildRecommendationTrack: 少于一训练窗口不产出记录', () => {
  const track = buildRecommendationTrack(makeDraws('ssq', 20), { game: GAMES.ssq, limit: 30 })
  assert.equal(track.items.length, 0)
  assert.equal(track.counters.samples, 0)
})

/* ── 统计对象 ─────────────────────────────────────────────── */

test('buildRecommendationHitStat: 分布、窗口与奖级自洽', () => {
  const game = GAMES.ssq
  const draws = makeDraws('ssq', 120)
  const track = buildRecommendationTrack(draws, { game, limit: 80 })
  const stat = buildRecommendationHitStat({
    counters: track.counters,
    recent: track.recent,
    game,
    kind: 'ssq',
    configKey: 'window=300',
    sample: {
      gameKey: 'ssq',
      kind: 'ssq',
      fromIssue: track.firstTracked.issue,
      toIssue: track.lastTracked.issue,
      drawCount: track.items.length,
    },
  })

  assert.equal(stat.overall.samples, 80)
  assert.equal(stat.shape.pickMain, 12)
  assert.equal(stat.shape.actualMain, 6)
  assert.equal(stat.windows.length, 4)
  assert.equal(stat.windows[0].window, 30)
  assert.ok(stat.overall.avgMainHits > 0)
  assert.ok(stat.overall.captureRate > 0 && stat.overall.captureRate < 1)
  assert.ok(stat.overall.lift > 0)

  const mainCount = stat.distribution.main.reduce((sum, item) => sum + item.count, 0)
  assert.equal(mainCount, 80)
  assert.equal(stat.tiers.reduce((sum, item) => sum + item.count, 0), stat.overall.winningIssues)
})

/* ── 奖级映射（用固定推荐/实际，避免依赖随机推荐） ───────── */

test('奖级: 大乐透 5+2 / 4+1', () => {
  const prediction = { main: [1, 2, 3, 4, 5], extra: [1, 2] }
  const actual = { main: [1, 2, 3, 4, 5], extra: [1, 2] }
  assert.equal(evaluateRecommendationTicket('dlt', prediction, actual).tier, '一等奖')

  const second = evaluateRecommendationTicket('dlt', prediction, {
    main: [1, 2, 3, 4, 9],
    extra: [1, 7],
  })
  assert.equal(second.tier, '五等奖')
})

test('奖级: 双色球 6+1 一等奖、5+1 三等奖、复式注数', () => {
  const actual = { main: [1, 2, 3, 4, 5, 6], extra: [1] }
  const single = evaluateRecommendationTicket('ssq', {
    main: [1, 2, 3, 4, 5, 6],
    extra: [1],
    primaryMain: [1, 2, 3, 4, 5, 6],
    primaryExtra: [1],
  }, actual)
  assert.equal(single.tier, '一等奖')
  assert.equal(single.winningUnits, 1)

  const five = evaluateRecommendationTicket('ssq', {
    main: [1, 2, 3, 4, 5, 9],
    extra: [1],
    primaryMain: [1, 2, 3, 4, 5, 9],
    primaryExtra: [1],
  }, actual)
  assert.equal(five.tier, '三等奖')
  assert.equal(five.winningUnits, 1)

  const pool = evaluateRecommendationTicket('ssq', {
    main: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    extra: [1, 2, 3, 4],
    primaryMain: [1, 2, 3, 4, 5, 6],
    primaryExtra: [1],
  }, actual)
  assert.equal(pool.tier, '一等奖')
  assert.ok(pool.winningUnits > 1, '12+4 复式应有多注中奖')
  assert.ok(pool.tiers.some((item) => item.tier === '二等奖'))
})

test('奖级: 快乐8 选十中十 / 选十中零', () => {
  const ten = evaluateRecommendationTicket('kl8', {
    main: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    extra: [],
  }, {
    main: Array.from({ length: 20 }, (_, index) => index + 1),
    extra: [],
  })
  assert.equal(ten.tier, '选十中十')

  const zero = evaluateRecommendationTicket('kl8', {
    main: [61, 62, 63, 64, 65, 66, 67, 68, 69, 70],
    extra: [],
  }, {
    main: Array.from({ length: 20 }, (_, index) => index + 1),
    extra: [],
  })
  assert.equal(zero.tier, '选十中零')
})
