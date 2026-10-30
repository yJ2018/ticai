import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TTG_BIN_EDGES,
  buildTtgOddsDistribution,
} from '../src/ttg-distribution.mjs'

/**
 * 分布口径：
 *   - 每场 8 个总进球选项按赔率升序；
 *   - 中奖排名 = 严格更低的选项数 + 1（并列共享排名）；
 *   - 缺项 / 非法赔率整场跳过；
 *   - 区间边界左闭右开，30 以上进最后一个区间。
 */

function row(overrides = {}) {
  return {
    matchId: 1,
    matchDate: '2026-10-25',
    leagueName: '测试联赛',
    homeName: '主队',
    awayName: '客队',
    homeScore: 1,
    awayScore: 0,
    ttg: 1,
    ttgOdds: {
      s0: '10.00',
      s1: '5.00',
      s2: '4.00',
      s3: '3.00',
      s4: '3.50',
      s5: '6.00',
      s6: '9.00',
      s7: '14.00',
    },
    oddsCapturedAt: '2026-10-25T11:00:00.000Z',
    ...overrides,
  }
}

test('最低 / 第二低 / 第三低 / 中奖赔率按场聚合，命中率与覆盖口径正确', () => {
  const data = buildTtgOddsDistribution(
    [
      row({ matchId: 1, ttg: 3 }), // 赔率 3.00 → 最低
      row({ matchId: 2, ttg: 7, matchDate: '2026-10-26' }), // 赔率 14.00 → 最高
    ],
    { settledResults: 4, updatedAt: '2026-10-27T00:00:00.000Z' },
  )

  assert.equal(data.sample.matches, 2)
  assert.equal(data.sample.settledResults, 4)
  assert.equal(data.sample.coverage, 0.5)
  assert.equal(data.sample.from, '2026-10-25')
  assert.equal(data.sample.to, '2026-10-26')
  assert.equal(data.sample.updatedAt, '2026-10-27T00:00:00.000Z')

  const series = Object.fromEntries(data.series.map((item) => [item.key, item]))
  assert.equal(series.lowest.min, 3)
  assert.equal(series.second.min, 3.5)
  assert.equal(series.third.min, 4)
  assert.equal(series.winning.average, 8.5)
  assert.equal(series.winning.max, 14)

  assert.equal(data.ranks[0].count, 1)
  assert.equal(data.ranks[7].count, 1)
  assert.equal(data.highlights.lowestHits, 1)
  assert.equal(data.highlights.lowestHitRate, 0.5)
  assert.equal(data.highlights.top3HitRate, 0.5)
  assert.equal(data.highlights.averageRatio, 2.83)

  // 3.00 落在 3–3.5，3.50 落在 3.5–4，4.00 落在 4–4.5，14 落在 10–15
  const bins = Object.fromEntries(data.bins.map((bin) => [bin.label, bin]))
  assert.equal(bins['3–3.5'].lowest, 2)
  assert.equal(bins['3.5–4'].second, 2)
  assert.equal(bins['4–4.5'].third, 2)
  assert.equal(bins['10–15'].winning, 1)
})

test('赔率并列时共享排名，不把同一档拆成两个人造名次', () => {
  const odds = {
    s0: '8.00',
    s1: '4.00',
    s2: '4.00',
    s3: '3.00',
    s4: '6.00',
    s5: '9.00',
    s6: '12.00',
    s7: '18.00',
  }

  const tiedSecond = buildTtgOddsDistribution([row({ ttg: 1, ttgOdds: odds })])
  assert.equal(tiedSecond.ranks[1].count, 1, '两个 4.00 并列第二低，排名应为 2')
  assert.equal(tiedSecond.ranks[2].count, 0)

  const tiedLowest = buildTtgOddsDistribution([
    row({ ttg: 3, ttgOdds: { ...odds, s3: '3.00', s4: '3.00' } }),
  ])
  assert.equal(tiedLowest.ranks[0].count, 1, '与最低赔率相同也记最低')
  assert.equal(tiedLowest.highlights.lowestHitRate, 1)
})

test('缺项或非法赔率整场跳过，空样本不产生 NaN', () => {
  const missing = row({
    ttgOdds: { s0: '10', s1: '5', s2: '4', s3: '3', s4: '4', s5: '6', s6: '9' },
  })
  const invalid = row({
    ttgOdds: { s0: '10', s1: '5', s2: '4', s3: '1.00', s4: '4', s5: '6', s6: '9', s7: '14' },
  })
  const empty = buildTtgOddsDistribution([missing, invalid])

  assert.equal(empty.sample.matches, 0)
  assert.equal(empty.sample.skipped, 2)
  assert.equal(empty.sample.coverage, 0)
  assert.equal(empty.series[0].average, null)
  assert.equal(empty.highlights.averageRatio, null)
  assert.ok(empty.bins.every((bin) => bin.lowest === 0 && bin.winning === 0))
})

test('区间边界左闭右开，30 以上进 30+', () => {
  const odds = {
    s0: '2.5',
    s1: '3',
    s2: '3.5',
    s3: '4',
    s4: '4.5',
    s5: '5',
    s6: '6',
    s7: '30',
  }

  const data = buildTtgOddsDistribution([row({ ttg: 7, ttgOdds: odds })])
  const bins = Object.fromEntries(data.bins.map((bin) => [bin.label, bin]))

  assert.equal(bins['<2.5'].lowest, 0, '2.50 是 2.5–3 的下界，不应落入 <2.5')
  assert.equal(bins['2.5–3'].lowest, 1)
  assert.equal(bins['3–3.5'].second, 1)
  assert.equal(bins['3.5–4'].third, 1)
  assert.equal(bins['30+'].winning, 1, '30.00 落在 30+')

  assert.deepEqual(TTG_BIN_EDGES.slice(0, 2), [1, 2.5])
  assert.equal(data.bins.at(-1).to, null)
})

test('样本按比赛日倒序进入 recent，比分与中奖排名一起输出', () => {
  const data = buildTtgOddsDistribution(
    [
      row({ matchId: 11, matchDate: '2026-10-20', ttg: 1, homeScore: 2, awayScore: 2 }),
      row({ matchId: 12, matchDate: '2026-10-28', ttg: 3, homeScore: 3, awayScore: 0 }),
    ],
    { recentLimit: 1 },
  )

  assert.equal(data.recent.length, 1)
  assert.equal(data.recent[0].matchId, 12)
  assert.equal(data.recent[0].score, '3:0')
  assert.equal(data.recent[0].rank, 1)
  assert.equal(data.recent[0].winning, 3)
  assert.equal(data.recent[0].rankLabel, '最低')
})
