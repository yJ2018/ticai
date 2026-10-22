import assert from 'node:assert/strict'
import test from 'node:test'

import { POOL_KEYS, buildAnalysisPrompt, formatWeather } from '../src/ai/prompt.mjs'

const match = {
  matchNo: '周四001',
  league: '欧罗巴联赛',
  homeName: '格风暴',
  awayName: '马赛',
  kickoffAt: '2026-10-22T00:45:00.000Z',
  status: 'scheduled',
}

const odds = {
  had: { h: '3.65', d: '3.80', a: '1.69' },
  hhad: { h: '1.95', d: '3.40', a: '3.10', goalLine: '+1' },
  ttg: { s0: '3.50', s1: '4.00', s2: '3.10', s3: '3.20', s4: '4.50', s5: '6.00', s6: '9.00', s7: '12.00' },
  hafu: { hh: '3.10', hd: '5.20', ha: '12.0', dh: '7.00', dd: '6.50', da: '8.00', ah: '15.0', ad: '11.0', aa: '9.00' },
  crs: { s01s00: '9.00', s02s00: '15.0', s02s01: '20.0', s00s00: '11.0', s1sh: '25.0' },
}

const feeds = {
  history: {
    matchList: [
      { matchDate: '2026-04-25', homeTeamShortName: '珀斯', awayTeamShortName: '格风暴', fullCourtGoal: '2:1' },
      { matchDate: '2026-02-11', homeTeamShortName: '格风暴', awayTeamShortName: '珀斯', fullCourtGoal: '0:0' },
      { matchDate: '2026-01-03', homeTeamShortName: '珀斯', awayTeamShortName: '格风暴', fullCourtGoal: '1:3' },
      { matchDate: '2025-11-20', homeTeamShortName: '格风暴', awayTeamShortName: '珀斯', fullCourtGoal: '2:2' },
    ],
    statistics: { totalLegCnt: 5, winProbability: '40%', drawProbability: '20%', lossProbability: '40%' },
  },
  injury: {
    home: { teamShortName: '格风暴', injuriesAndSuspensionsList: [] },
    away: {
      teamShortName: '马赛',
      injuriesAndSuspensionsList: [
        { personName: '赫伊别尔', playerPositionDesc: '中场' },
        { personName: '科尼利厄斯', playerPositionDesc: '后卫' },
        { personName: 'A', playerPositionDesc: '前锋' },
        { personName: 'B', playerPositionDesc: '前锋' },
        { personName: 'C', playerPositionDesc: '门将' },
      ],
    },
  },
  result: {
    home: {
      matchList: [
        { matchDate: '2026-10-18', homeTeamShortName: '格风暴', awayTeamShortName: 'GAK', fullCourtGoal: '6:1' },
        { matchDate: '2026-10-16', homeTeamShortName: '伯恩茅斯', awayTeamShortName: '格风暴', fullCourtGoal: '3:0' },
        { matchDate: '2026-10-11', homeTeamShortName: '维也纳', awayTeamShortName: '格风暴', fullCourtGoal: '0:2' },
        { matchDate: '2026-10-02', homeTeamShortName: '格风暴', awayTeamShortName: 'FAC', fullCourtGoal: '3:1' },
        { matchDate: '2026-09-20', homeTeamShortName: '萨堡', awayTeamShortName: '格风暴', fullCourtGoal: '3:0' },
      ],
    },
    away: { matchList: [] },
  },
  tables: {
    tournamentShortName: '欧罗巴',
    tables: [
      { teamShortName: '格风暴', ranking: '14', points: '4' },
      { teamShortName: '马赛', ranking: '27', points: '1' },
    ],
  },
  shooter: { home: { playerList: [{ personName: 'X', goalCnt: 3 }] }, away: { playerList: [] } },
}

const weather = {
  available: true,
  city: 'Graz',
  current: { temperature: 12, weather: '多云', humidity: 70 },
  kickoff: { precipitationProbability: 20 },
}

test('完整数据：各段落都在，且没有把用不上的源塞进去', () => {
  const prompt = buildAnalysisPrompt({ match, odds, feeds, weather, pool: 'ttg' })

  for (const line of ['比赛：', '玩法：', '赔率：', '交锋：', '伤停：', '近况：', '排名：', '天气：']) {
    assert.ok(prompt.user.includes(line), `缺少 ${line}`)
  }
  // 射手、未来赛程不进提示词（对赛果预测价值低）
  assert.ok(!prompt.user.includes('射手'))
  assert.ok(!prompt.user.includes('未来'))
})

test('缺数据时直接不写那一段，不产生「暂无数据」占位', () => {
  const prompt = buildAnalysisPrompt({ match, odds: null, feeds: {}, weather: null, pool: 'had' })
  const contentLines = prompt.user.split('\n').filter(Boolean)

  // 比赛 / 玩法 / 结尾指令
  assert.equal(contentLines.length, 3)
  assert.ok(contentLines[0].startsWith('比赛：'))
  assert.ok(!prompt.user.includes('赔率：'))
  assert.ok(!prompt.user.includes('暂无'))
})

test('玩法决定带哪些赔率：混合过关不带 31 个比分选项', () => {
  const mixed = buildAnalysisPrompt({ match, odds, feeds, weather, pool: 'mixed' })
  assert.ok(mixed.user.includes('胜平负'))
  assert.ok(mixed.user.includes('总进球'))
  assert.ok(mixed.user.includes('半全场'))
  assert.ok(!mixed.user.includes('比分 1:0'), '混合过关应省略比分选项')

  const crs = buildAnalysisPrompt({ match, odds, feeds, weather, pool: 'crs' })
  assert.ok(crs.user.includes('比分'))
  assert.ok(!crs.user.includes('半全场'))

  const had = buildAnalysisPrompt({ match, odds, feeds, weather, pool: 'had' })
  assert.ok(had.user.includes('胜平负'))
  assert.ok(!had.user.includes('总进球'))
})

test('列表类数据都做了截断：交锋 3 场、伤停每队 4 人、近况 4 场', () => {
  const prompt = buildAnalysisPrompt({ match, odds, feeds, weather, pool: 'ttg' })

  const h2hLine = prompt.user.split('\n').find((line) => line.startsWith('交锋：'))
  assert.equal((h2hLine.match(/、/g) ?? []).length + 1, 3, '交锋应只保留 3 场')

  const injuryLine = prompt.user.split('\n').find((line) => line.startsWith('伤停：'))
  assert.ok(injuryLine.includes('格风暴无'))
  assert.equal((injuryLine.match(/、/g) ?? []).length + 1, 4, '每队最多 4 人')

  const recentLine = prompt.user.split('\n').find((line) => line.startsWith('近况：'))
  assert.ok(recentLine.includes('10-18胜6:1'))
  assert.equal((recentLine.match(/胜|平|负/g) ?? []).length, 4, '近况只保留 4 场')
})

test('天气压成一行，缺失返回空串', () => {
  assert.equal(formatWeather(null), '')
  assert.equal(formatWeather({ available: false }), '')
  const line = formatWeather(weather)
  assert.ok(line.includes('12℃'))
  assert.ok(!line.includes('\n'))
})

test('提示词长度可控（同一场比赛不会超过 900 字符）', () => {
  for (const pool of POOL_KEYS) {
    const prompt = buildAnalysisPrompt({ match, odds, feeds, weather, pool })
    assert.ok(prompt.chars < 900, `${pool} 太长：${prompt.chars}`)
  }
})

test('阵容：只写首发与阵型，标注预测', () => {
  const lineup = {
    home: { formation: '4-2-3-1', confirmed: true, starters: ['门将A', '后卫B', '中场C'] },
    away: { formation: '4-3-3', confirmed: false, starters: ['前锋X', '前锋Y'] },
  }
  const prompt = buildAnalysisPrompt({ match, odds, feeds, weather, pool: 'ttg', lineup })
  const line = prompt.user.split('\n').find((item) => item.startsWith('阵容：'))
  assert.ok(line, '应输出阵容行')
  assert.ok(line.includes('4-2-3-1'))
  assert.ok(line.includes('门将A'))
  assert.ok(line.includes('（预测）'), '未确认的阵容要标注预测')

  const empty = buildAnalysisPrompt({ match, odds, feeds, weather, pool: 'ttg', lineup: null })
  assert.ok(!empty.user.includes('阵容：'))
})
