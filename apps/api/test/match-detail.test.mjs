import assert from 'node:assert/strict'
import test from 'node:test'

import { MATCH_FEED_KEYS, buildMatchDetail } from '../src/match-detail.mjs'

const matchRow = (overrides = {}) => ({
  sporttery_match_id: '2042155',
  league_name: '澳超',
  kickoff_at: new Date('2026-10-23T09:00:00.000Z'),
  status: 'scheduled',
  sell_status: 'on_sale',
  home_name: '布里斯班',
  away_name: '珀斯',
  home_score: null,
  away_score: null,
  home_half_score: null,
  away_half_score: null,
  htft: null,
  result_source: null,
  ...overrides,
})

const feedRow = (feed, payload) => ({ feed, payload, fetched_at: new Date('2026-10-22T07:00:00.000Z') })

test('buildMatchDetail: 7 个源齐全时不产出 missing', () => {
  const feeds = MATCH_FEED_KEYS.map((key) =>
    feedRow(key, {
      home: { matchList: [{ sportteryMatchId: 1 }], playerList: [{ personId: 1 }], injuriesAndSuspensionsList: [{ personId: 1 }] },
      away: { matchList: [{ sportteryMatchId: 2 }], playerList: [{ personId: 2 }], injuriesAndSuspensionsList: [{ personId: 2 }] },
      tables: [{ ranking: 1 }],
    }),
  )

  const detail = buildMatchDetail({ match: matchRow(), feeds })

  assert.deepEqual(detail.missing, [])
  assert.equal(detail.matchId, 2042155)
  assert.equal(detail.home.name, '布里斯班')
  assert.equal(detail.league, '澳超')
})

test('buildMatchDetail: 一个源都没有时全部为 null，且 missing 列全', () => {
  const detail = buildMatchDetail({ match: matchRow(), feeds: [] })

  assert.deepEqual(detail.missing, MATCH_FEED_KEYS)
  for (const key of MATCH_FEED_KEYS) {
    assert.equal(detail.feeds[key], null)
    assert.equal(detail.fetchedAt[key], null)
  }
})

test('buildMatchDetail: 空对象 payload 视为缺失', () => {
  const detail = buildMatchDetail({ match: matchRow(), feeds: [feedRow('history', {})] })
  assert.ok(detail.missing.includes('history'))
})

test('buildMatchDetail: 射手榜主队 0 人也算缺失，但空数组原样保留', () => {
  const detail = buildMatchDetail({
    match: matchRow(),
    feeds: [
      feedRow('shooter', {
        home: { playerList: [] },
        away: { playerList: [{ personId: 2 }] },
      }),
    ],
  })

  assert.deepEqual(detail.feeds.shooter.home.playerList, [])
  assert.ok(detail.missing.includes('shooter.home'))
  assert.ok(!detail.missing.includes('shooter.away'))
})

test('buildMatchDetail: 比分与半全场透传，未开赛为 null', () => {
  const finished = buildMatchDetail({
    match: matchRow({
      home_score: 2,
      away_score: 5,
      home_half_score: 1,
      away_half_score: 2,
      htft: 'aa',
      status: 'finished',
      result_source: 'sporttery',
    }),
    feeds: [],
  })

  assert.equal(finished.home.score, 2)
  assert.equal(finished.away.score, 5)
  assert.equal(finished.home.halfScore, 1)
  assert.equal(finished.htft, 'aa')
  assert.equal(finished.resultSource, 'sporttery')

  const scheduled = buildMatchDetail({ match: matchRow(), feeds: [] })
  assert.equal(scheduled.home.score, null)
  assert.equal(scheduled.htft, null)
})
