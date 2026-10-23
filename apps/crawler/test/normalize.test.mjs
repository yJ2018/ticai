import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hashOdds,
  normalizeDraw,
  normalizeMatch,
  parseKickoff,
  parseMoney,
  parseNumbers,
  resolveMatchDate,
  stableStringify,
} from '../src/normalize.mjs'

test('parseKickoff: 补上 +08:00，避免 UTC 进程里差 8 小时', () => {
  assert.equal(parseKickoff('2026-10-22', '20:00'), '2026-10-22T20:00:00+08:00')
  assert.equal(parseKickoff('2026-10-22', '20:00:30'), '2026-10-22T20:00:30+08:00')
  // 缺失时刻按 00:00 兜底，但日期必须合法
  assert.equal(parseKickoff('2026-10-22', ''), '2026-10-22T00:00:00+08:00')
})

test('parseKickoff: 非法日期直接抛错，不静默产出脏数据', () => {
  assert.throws(() => parseKickoff('2026/10/22', '20:00'), /businessDate/)
  assert.throws(() => parseKickoff(undefined, '20:00'), /businessDate/)
})

test('resolveMatchDate: 跨零点场次用 matchDate，缺失时才退回销售日', () => {
  // 周五002 属于 10-23 的销售日，但实际是 10-24 00:30 开赛
  assert.equal(resolveMatchDate({ matchDate: '2026-10-24' }, '2026-10-23'), '2026-10-24')
  // 带时分秒也按前 10 位取
  assert.equal(resolveMatchDate({ matchDate: '2026-10-24 00:30:00' }, '2026-10-23'), '2026-10-24')
  // 上游没给 matchDate / 给了脏值 → 退回销售日
  assert.equal(resolveMatchDate({}, '2026-10-23'), '2026-10-23')
  assert.equal(resolveMatchDate({ matchDate: '0000-00-00' }, '2026-10-23'), '2026-10-23')
})

test('normalizeMatch: 凌晨场次的开赛时间不会被提前一天', () => {
  const row = normalizeMatch(
    {
      matchId: 9101,
      matchNumStr: '周五002',
      matchDate: '2026-10-24',
      matchTime: '00:30:00',
      leagueAllName: '德乙',
      homeTeamId: 2001,
      awayTeamId: 2002,
      homeTeamAbbName: '波鸿',
      awayTeamAbbName: '沃夫斯堡',
    },
    '2026-10-23',
  )

  assert.equal(row.kickoffAt, '2026-10-24T00:30:00+08:00')
  // 销售日仍是期号所属的那一天
  assert.equal(row.businessDate, '2026-10-23')
})

test('parseNumbers: 大乐透 7 个号码拆成前区 5 + 后区 2', () => {
  const result = parseNumbers('01 06 10 15 32 03 04', { mainCount: 5, extraCount: 2 })
  assert.deepEqual(result.main, [1, 6, 10, 15, 32])
  assert.deepEqual(result.extra, [3, 4])
})

test('parseNumbers: 排列五保留 0，且不改顺序', () => {
  const result = parseNumbers('8 6 4 0 3', { mainCount: 5, extraCount: 0 })
  assert.deepEqual(result.main, [8, 6, 4, 0, 3])
  assert.deepEqual(result.extra, [])
})

test('parseNumbers: 七星彩 7 位', () => {
  const result = parseNumbers('8 9 1 1 5 9 5', { mainCount: 7, extraCount: 0 })
  assert.equal(result.main.length, 7)
  assert.deepEqual(result.main, [8, 9, 1, 1, 5, 9, 5])
})

test('parseNumbers: 无空格时按位兜底', () => {
  const result = parseNumbers('86403', { mainCount: 5, extraCount: 0 })
  assert.deepEqual(result.main, [8, 6, 4, 0, 3])
})

test('parseNumbers: 位数不符必须报错', () => {
  assert.throws(() => parseNumbers('8 6 4', { mainCount: 5, extraCount: 0 }), /位数不符/)
  assert.throws(() => parseNumbers('', { mainCount: 5 }), /为空/)
})

test('parseMoney: 去掉千分位，保留小数', () => {
  assert.equal(parseMoney('314,954,142'), '314954142')
  assert.equal(parseMoney('824,436,634.68'), '824436634.68')
  assert.equal(parseMoney('0'), '0')
  assert.equal(parseMoney(undefined), null)
  assert.equal(parseMoney('--'), null)
})

test('stableStringify: 键顺序无关', () => {
  const a = stableStringify({ b: '1', a: { d: '2', c: '3' } })
  const b = stableStringify({ a: { c: '3', d: '2' }, b: '1' })
  assert.equal(a, b)
})

test('hashOdds: updateTime 变化不算赔率变化', () => {
  const before = hashOdds({ had: { h: '2.10', d: '3.40', a: '3.60', updateTime: '10:00:00' } })
  const after = hashOdds({ had: { h: '2.10', d: '3.40', a: '3.60', updateTime: '10:05:00' } })
  assert.equal(before, after)
})

test('hashOdds: 赔率真的变了就换 hash', () => {
  const before = hashOdds({ had: { h: '2.10', d: '3.40', a: '3.60' } })
  const after = hashOdds({ had: { h: '2.05', d: '3.40', a: '3.60' } })
  assert.notEqual(before, after)
})

test('normalizeMatch: 只收集存在的玩法，并带上开赛时间', () => {
  const row = normalizeMatch(
    {
      matchId: 9001,
      matchNumStr: '周四001',
      leagueAllName: '英超',
      homeTeamId: 1001,
      awayTeamId: 1002,
      homeTeamAbbName: '阿森纳',
      awayTeamAbbName: '切尔西',
      matchTime: '20:00:00',
      had: { h: '2.10', d: '3.40', a: '3.60', updateTime: '10:00:00' },
      hafu: {},
    },
    '2026-10-22',
  )

  assert.equal(row.sportteryMatchId, 9001)
  assert.equal(row.kickoffAt, '2026-10-22T20:00:00+08:00')
  assert.equal(row.leagueName, '英超')
  assert.deepEqual(Object.keys(row.odds), ['had'])
  assert.equal(row.oddsHash.length, 64)
})

test('normalizeDraw: 金额、号码、奖级都落到对应字段', () => {
  const row = normalizeDraw(
    {
      lotteryDrawNum: '26120',
      lotteryDrawTime: '2026-10-21',
      lotteryDrawResult: '01 06 10 15 32 03 04',
      totalSaleAmount: '314,954,142',
      poolBalance: '824,436,634.68',
      poolBalanceAfterdraw: '825,893,883.63',
      prizeLevelList: [
        {
          prizeLevel: '一等奖',
          sort: 101,
          stakeCount: '3',
          stakeAmountFormat: '10000000',
          totalPrizeamount: '30,000,000',
        },
      ],
    },
    { gameNo: '85', mainCount: 5, extraCount: 2 },
  )

  assert.equal(row.issueSeq, 26120)
  assert.deepEqual(row.mainNumbers, [1, 6, 10, 15, 32])
  assert.deepEqual(row.extraNumbers, [3, 4])
  assert.equal(row.salesAmount, '314954142')
  assert.equal(row.poolBalance, '824436634.68')
  assert.equal(row.prizes.length, 1)
  assert.equal(row.prizes[0].prizeKey, '一等奖')
  assert.equal(row.prizes[0].stakeCount, '3')
  assert.equal(row.prizes[0].totalAmount, '30000000')
})

test('normalizeDraw: 期号或日期异常时抛错，交给上层跳过', () => {
  const game = { gameNo: '35', mainCount: 3, extraCount: 0 }
  assert.throws(
    () => normalizeDraw({ lotteryDrawNum: 'abc', lotteryDrawResult: '1 2 3' }, game),
    /期号非法/,
  )
  assert.throws(
    () => normalizeDraw({ lotteryDrawNum: '1', lotteryDrawResult: '1 2 3' }, game),
    /开奖日期非法/,
  )
})
import { parseGoalPair, parseResultEntries, parseInjuryEntries } from '../src/normalize.mjs'

test('parseGoalPair: 解析全场/半场比分', () => {
  assert.deepEqual(parseGoalPair('2:5'), { home: 2, away: 5 })
  assert.deepEqual(parseGoalPair('0:0'), { home: 0, away: 0 })
  assert.equal(parseGoalPair(''), null)
  assert.equal(parseGoalPair(undefined), null)
  assert.equal(parseGoalPair('2-5'), null)
})

test('parseResultEntries: 主客两侧去重，并带出半场比分', () => {
  const entries = parseResultEntries({
    home: {
      matchList: [
        { sportteryMatchId: 2042060, matchDate: '2026-10-18', fullCourtGoal: '2:5', halfTimeGoal: '1:2', homeTeamShortName: '昂热', awayTeamShortName: '马赛', tournamentShortName: '法甲' },
        { sportteryMatchId: 0, fullCourtGoal: '1:0' },
      ],
    },
    away: {
      matchList: [
        { sportteryMatchId: 2042060, fullCourtGoal: '2:5', halfTimeGoal: '1:2' },
      ],
    },
  })

  assert.equal(entries.length, 1)
  assert.equal(entries[0].sportteryMatchId, 2042060)
  assert.equal(entries[0].homeScore, 2)
  assert.equal(entries[0].awayScore, 5)
  assert.equal(entries[0].homeHalfScore, 1)
  assert.equal(entries[0].awayHalfScore, 2)
  assert.equal(entries[0].matchDate, '2026-10-18')
})

test('parseResultEntries: 没有比分的场次直接跳过', () => {
  const entries = parseResultEntries({ home: { matchList: [{ sportteryMatchId: 1, fullCourtGoal: '' }] } })
  assert.deepEqual(entries, [])
})

test('parseInjuryEntries: 区分伤病与停赛，带上球队 ID', () => {
  const entries = parseInjuryEntries({
    home: {
      sportteryTeamId: 1276,
      injuriesAndSuspensionsList: [
        { personId: 182609, personName: '赫伊别尔', playerPositionDesc: '中场', uniformNo: '23', injuryFlag: 1, suspensionFlag: 0, appearanceCnt: 1 },
      ],
    },
    away: {
      sportteryTeamId: 182,
      injuriesAndSuspensionsList: [
        { personId: 289024, personName: '科尼利厄斯', playerPositionDesc: '后卫', uniformNo: '13', injuryFlag: 0, suspensionFlag: 1 },
      ],
    },
  })

  assert.equal(entries.length, 2)
  assert.equal(entries[0].teamSportteryId, 1276)
  assert.equal(entries[0].kind, 'injury')
  assert.equal(entries[0].uniformNo, 23)
  assert.equal(entries[1].teamSportteryId, 182)
  assert.equal(entries[1].kind, 'suspension')
})

test('parseInjuryEntries: 空名单返回空数组', () => {
  assert.deepEqual(parseInjuryEntries({}), [])
  assert.deepEqual(parseInjuryEntries({ home: { sportteryTeamId: 1, injuriesAndSuspensionsList: [] } }), [])
})
