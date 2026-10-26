import assert from 'node:assert/strict'
import test from 'node:test'

import { crsKey, hafuKey, normalizeMatchResult, parseGoalLine } from '../src/normalize.mjs'
import { shanghaiDate, splitRange } from '../src/tasks/results.mjs'

test('crsKey: 与前端比分玩法 key 完全一致', () => {
  assert.equal(crsKey(1, 0), 's01s00')
  assert.equal(crsKey(3, 2), 's03s02')
  assert.equal(crsKey(5, 2), 's05s02')
  // 官方只开这些比分，其余归入「胜其它 / 负其它 / 平其它」
  assert.equal(crsKey(6, 0), 's1sh')
  assert.equal(crsKey(7, 1), 's1sh')
  assert.equal(crsKey(0, 0), 's00s00')
  assert.equal(crsKey(3, 3), 's03s03')
  assert.equal(crsKey(4, 4), 's1sd')
  assert.equal(crsKey(0, 5), 's00s05')
  assert.equal(crsKey(1, 5), 's01s05')
  assert.equal(crsKey(0, 6), 's1sa')
})

test('hafuKey: 半场结果 + 全场结果', () => {
  assert.equal(hafuKey(0, 0, 1, 0), 'dh')
  assert.equal(hafuKey(1, 0, 2, 1), 'hh')
  assert.equal(hafuKey(0, 1, 2, 1), 'ah')
  assert.equal(hafuKey(1, 1, 1, 1), 'dd')
})

test('parseGoalLine: 带符号的让球数', () => {
  assert.equal(parseGoalLine('-1'), -1)
  assert.equal(parseGoalLine('+2'), 2)
  assert.equal(parseGoalLine('0'), 0)
  assert.equal(parseGoalLine(''), null)
  assert.equal(parseGoalLine(undefined), null)
})

test('normalizeMatchResult: 比分推导出全部玩法', () => {
  const row = normalizeMatchResult({
    matchId: 2042216,
    matchNumStr: '周日004',
    matchDate: '2026-10-25',
    leagueId: 42,
    leagueName: '日本职业联赛',
    allHomeTeam: '川崎前锋',
    allAwayTeam: '冈山绿雉',
    homeTeamId: 553,
    awayTeamId: 1194,
    sectionsNo1: '1:0',
    sectionsNo999: '2:1',
    goalLine: '-1',
    winFlag: 'H',
    poolStatus: 'Payout',
    matchResultStatus: '2',
  })

  assert.equal(row.sportteryMatchId, 2042216)
  assert.equal(row.halfHome, 1)
  assert.equal(row.halfAway, 0)
  assert.equal(row.fullHome, 2)
  assert.equal(row.fullAway, 1)
  assert.equal(row.goalLine, -1)
  assert.equal(row.hadResult, 'h')
  // 2 - 1 = 1，让一球后 1:1 → 让球平
  assert.equal(row.hhadResult, 'd')
  assert.equal(row.ttgResult, 3)
  assert.equal(row.crsResult, 's02s01')
  assert.equal(row.hafuResult, 'hh')
  assert.equal(row.settled, true)
})

test('normalizeMatchResult: 未开奖时只落赛程信息，不猜结果', () => {
  const row = normalizeMatchResult({
    matchId: 2042218,
    matchNumStr: '周日006',
    allHomeTeam: '国际米兰',
    allAwayTeam: '佛罗伦萨',
    sectionsNo1: '',
    sectionsNo999: '',
    goalLine: '-1',
    winFlag: '',
  })

  assert.equal(row.settled, false)
  assert.equal(row.fullHome, null)
  assert.equal(row.hadResult, null)
  assert.equal(row.hhadResult, null)
  assert.equal(row.crsResult, null)
  assert.equal(row.hafuResult, null)
})

test('normalizeMatchResult: 缺 matchId 直接抛错，不写脏行', () => {
  assert.throws(() => normalizeMatchResult({}), /matchId/)
})

test('normalizeMatchResult: 总进球封顶 7，对应 s7', () => {
  const row = normalizeMatchResult({
    matchId: 1,
    allHomeTeam: 'A',
    allAwayTeam: 'B',
    sectionsNo1: '0:0',
    sectionsNo999: '6:2',
    goalLine: '0',
  })
  assert.equal(row.ttgResult, 7)
  assert.equal(row.crsResult, 's1sh')
})

test('splitRange: 超过 7 天自动切块', () => {
  const chunks = splitRange('2026-10-01', '2026-10-20')
  assert.equal(chunks.length, 3)
  assert.deepEqual(chunks[0], { begin: '2026-10-01', end: '2026-10-07' })
  assert.deepEqual(chunks[2], { begin: '2026-10-15', end: '2026-10-20' })
  assert.deepEqual(splitRange('2026-10-20', '2026-10-01'), [])
})

test('shanghaiDate: 以北京时间为准，不受进程时区影响', () => {
  const now = new Date('2026-10-25T14:00:00Z') // 北京 10-25 22:00
  assert.equal(shanghaiDate(0, now), '2026-10-25')
  assert.equal(shanghaiDate(-2, now), '2026-10-23')
})
