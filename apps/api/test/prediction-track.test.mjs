import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeHistoryPrediction } from '../src/analysis/history-prediction.mjs'
import {
  PREDICTION_BASELINE,
  buildPredictionTrack,
  buildTrackStat,
} from '../src/analysis/prediction-track.mjs'

/**
 * 逐期归档的硬约束：
 *   1. 累计 Top1/Top3 必须和既有回测的 top1Hits/top3Hits 完全对上；
 *   2. 增量续算必须和一次性全量完全一致。
 * 这两条一破，页面上的命中率就不可信了。
 */

function lcg(seed) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

function makeEntries(count, { seed = 7, positionCount = 5, digits = 10 } = {}) {
  const random = lcg(seed)
  return Array.from({ length: count }, (_, index) => {
    const seq = 26000 - (count - 1 - index)
    return {
      issue: String(seq),
      issueSeq: seq,
      drawDate: `2026-10-${String((index % 27) + 1).padStart(2, '0')}`,
      numbers: Array.from({ length: positionCount }, () =>
        String(Math.floor(random() * digits)),
      ),
    }
  })
}


test('buildPredictionTrack: 累计命中与既有回测完全一致（排列五 300 期）', () => {
  const entries = makeEntries(300)
  const track = buildPredictionTrack(entries, { positionCount: 5 })
  const snapshot = analyzeHistoryPrediction(
    entries.map((entry) => ({ issue: entry.issue, numbers: entry.numbers })),
    { positionCount: 5 },
  )

  assert.equal(track.items.length, 300 - 30)
  for (let position = 0; position < 5; position += 1) {
    const backtest = snapshot.positions[position].backtest
    const counters = track.counters.positions[position]
    assert.equal(counters.samples, backtest.samples)
    assert.equal(counters.top1Hits, backtest.top1Hits)
    assert.equal(counters.top3Hits, backtest.top3Hits)
  }
})

test('buildPredictionTrack: 逐期记录只用上一期为止的数据（throughIssue）', () => {
  const entries = makeEntries(120)
  const track = buildPredictionTrack(entries, { positionCount: 5 })
  const first = track.items[0]
  const previous = entries[entries.length - track.items.length - 1]

  assert.equal(first.throughIssue, previous.issue)
  assert.equal(first.throughIssueSeq, previous.issueSeq)
  assert.equal(first.actual.length, 5)
  assert.equal(first.positions.length, 5)
  assert.ok(first.positions.every((item) => item.picks.length === 3))
  assert.ok(first.positions.every((item) => item.hitTop3 === item.picks.includes(item.actual)))
  assert.equal(first.top3Hits, first.positions.filter((item) => item.hitTop3).length)
})

test('buildPredictionTrack: 增量续算 == 一次性全量（含累计与最近命中）', () => {
  const entries = makeEntries(260)
  const full = buildPredictionTrack(entries, { positionCount: 5 })

  const splitIndex = 190
  const head = buildPredictionTrack(entries.slice(0, splitIndex), { positionCount: 5 })
  const tail = buildPredictionTrack(entries, {
    positionCount: 5,
    sinceSeq: head.lastTracked.issueSeq,
    counters: head.counters,
    recent: head.recent,
  })

  assert.deepEqual(
    tail.counters,
    full.counters,
    '增量累计计数必须和全量完全一致',
  )
  assert.deepEqual(
    tail.recent.map((item) => [item.issue, item.top1, item.top3, item.mask]),
    full.recent.map((item) => [item.issue, item.top1, item.top3, item.mask]),
  )
  assert.deepEqual(
    tail.items.map((item) => item.issue),
    full.items.slice(head.items.length).map((item) => item.issue),
  )
})

test('buildPredictionTrack: 七星彩末位 10–14 算未命中，但不进入打分序列', () => {
  const random = lcg(31)
  const entries = Array.from({ length: 80 }, (_, index) => {
    const seq = 26100 - (80 - 1 - index)
    const last = index % 4 === 0 ? 10 + (index % 5) : Math.floor(random() * 10)
    return {
      issue: String(seq),
      issueSeq: seq,
      drawDate: '2026-10-27',
      numbers: [
        String(Math.floor(random() * 10)),
        String(Math.floor(random() * 10)),
        String(Math.floor(random() * 10)),
        String(Math.floor(random() * 10)),
        String(Math.floor(random() * 10)),
        String(Math.floor(random() * 10)),
        String(last),
      ],
    }
  })

  const track = buildPredictionTrack(entries, { positionCount: 7 })
  const withTwoDigit = track.items.filter((item) => item.actual[6] >= 10)
  assert.ok(withTwoDigit.length > 0)
  for (const item of withTwoDigit) {
    assert.equal(item.positions[6].hitTop1, false)
    assert.equal(item.positions[6].hitTop3, false)
    assert.equal(item.positions[6].rank, null)
  }
})

test('buildPredictionTrack: 历史不足 minTrainingSize 时按总期数自适应', () => {
  const ten = makeEntries(10)
  const tenTrack = buildPredictionTrack(ten, { positionCount: 5 })
  assert.equal(tenTrack.items.length, 0, '10 期时 minTraining 自适应到 10，没有可预测的期次')

  const twelve = makeEntries(12)
  const twelveTrack = buildPredictionTrack(twelve, { positionCount: 5 })
  assert.equal(twelveTrack.items.length, 1, '12 期时 minTraining 自适应到 11，只剩 1 期可回测')
})

test('buildTrackStat: 命中率、偏差、窗口、号码矩阵口径自洽', () => {
  const entries = makeEntries(400)
  const track = buildPredictionTrack(entries, { positionCount: 5 })
  const stat = buildTrackStat({
    counters: track.counters,
    recent: track.recent,
    positionCount: 5,
    configKey: 'markov=2',
    sample: {
      fromIssue: track.firstTracked.issue,
      toIssue: track.lastTracked.issue,
      drawCount: track.items.length,
    },
  })

  assert.equal(stat.overall.samples, 370)
  assert.equal(stat.positions.length, 5)
  assert.equal(stat.digits.length, 5)
  assert.deepEqual(stat.baseline, PREDICTION_BASELINE)

  const averageTop3 =
    stat.positions.reduce((sum, item) => sum + item.top3Rate, 0) / stat.positions.length
  assert.ok(Math.abs(averageTop3 - stat.overall.top3Rate) < 1e-12)
  assert.ok(
    Math.abs(stat.overall.top3Deviation - (stat.overall.top3Rate - PREDICTION_BASELINE.top3)) <
      1e-12,
  )

  for (const row of stat.digits) {
    const picked = row.reduce((sum, item) => sum + item.picked, 0)
    assert.equal(picked, stat.overall.samples * 3)
    const actual = row.reduce((sum, item) => sum + item.actual, 0)
    assert.equal(actual, stat.overall.samples)
  }

  assert.equal(stat.windows.find((item) => item.window === 30).samples, 30)
  assert.equal(stat.windows.find((item) => item.window === 1000).samples, 370)
  assert.equal(stat.rolling.length, 120)
  assert.equal(stat.rolling.at(-1).issue, track.lastTracked.issue)
  assert.ok(stat.combinations.samples > 0)
  assert.equal(
    stat.combinations.samples,
    stat.combinations.distribution.reduce((sum, item) => sum + item.count, 0),
  )
})
