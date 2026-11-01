import assert from 'node:assert/strict'
import test from 'node:test'

import {
  competitorOf,
  espnLeagueSlug,
  parseEspnLineup,
  pickEvent,
  toUtcDateKey,
} from '../src/espn.mjs'

function event(id, iso, homeAbbr, awayAbbr) {
  return {
    id,
    date: iso,
    competitions: [
      {
        competitors: [
          { homeAway: 'home', team: { abbreviation: homeAbbr } },
          { homeAway: 'away', team: { abbreviation: awayAbbr } },
        ],
      },
    ],
  }
}

function side(homeAway, { starters = 11, bench = 4, formation = '4-3-3' } = {}) {
  const roster = []
  for (let i = 0; i < starters; i += 1) {
    roster.push({
      starter: true,
      jersey: String(i + 1),
      position: { abbreviation: 'MF' },
      athlete: { displayName: `首发${i + 1}` },
    })
  }
  for (let i = 0; i < bench; i += 1) {
    roster.push({
      starter: false,
      jersey: String(20 + i),
      position: { abbreviation: 'SUB' },
      athlete: { displayName: `替补${i + 1}` },
    })
  }
  return { homeAway, formation, roster }
}

test('联赛名映射到 ESPN slug，未知联赛返回 null', () => {
  assert.equal(espnLeagueSlug('英格兰超级联赛'), 'eng.1')
  assert.equal(espnLeagueSlug('荷甲'), 'ned.1')
  assert.equal(espnLeagueSlug('韩国职业联赛'), null)
  assert.equal(espnLeagueSlug(''), null)
})

test('dateKey 按 UTC 切，凌晨场次不会落到第二天', () => {
  assert.equal(toUtcDateKey('2026-11-02T00:30:00+08:00'), '20261101')
  assert.equal(toUtcDateKey('2026-11-01T19:15:00+08:00'), '20261101')
  assert.equal(toUtcDateKey(new Date('2026-11-03T03:45:00+08:00')), '20261102')
})

test('开赛时间唯一时直接对上', () => {
  const match = { kickoffAt: '2026-11-02T00:30:00+08:00', homeCode: 'LIV' }
  const picked = pickEvent(match, [
    event('e1', '2026-11-01T16:30Z', 'LIV', 'ARS'),
    event('e2', '2026-11-01T14:00Z', 'MCI', 'CHE'),
  ])
  assert.equal(picked?.id, 'e1')
})

test('同一时间多场时，用主队缩写消歧', () => {
  const match = { kickoffAt: '2026-11-01T22:00:00+08:00', homeCode: 'LAZ' }
  const picked = pickEvent(match, [
    event('e1', '2026-11-01T14:00Z', 'LAZ', 'CAG'),
    event('e2', '2026-11-01T14:00Z', 'FRO', 'TOR'),
  ])
  assert.equal(picked?.id, 'e1')
})

test('缩写不是同一套时按相似度消歧（MAM/MAL、EXE/EXC）', () => {
  const malmo = pickEvent(
    { kickoffAt: '2026-11-01T21:00:00+08:00', homeCode: 'MAM', awayCode: 'HAM' },
    [
      event('e1', '2026-11-01T13:00Z', 'MAL', 'HAM'),
      event('e2', '2026-11-01T13:00Z', 'DEG', 'DJU'),
    ],
  )
  assert.equal(malmo?.id, 'e1')

  const excelsior = pickEvent(
    { kickoffAt: '2026-11-01T21:30:00+08:00', homeCode: 'EXE', awayCode: 'FCT' },
    [
      event('e1', '2026-11-01T13:30Z', 'EXC', 'TWE'),
      event('e2', '2026-11-01T13:30Z', 'UTR', 'TEL'),
    ],
  )
  assert.equal(excelsior?.id, 'e1')
})

test('消歧不唯一时放弃，避免把阵容写到别的比赛', () => {
  const match = { kickoffAt: '2026-11-01T22:00:00+08:00', homeCode: 'XXX' }
  const picked = pickEvent(match, [
    event('e1', '2026-11-01T14:00Z', 'LAZ', 'CAG'),
    event('e2', '2026-11-01T14:00Z', 'FRO', 'TOR'),
  ])
  assert.equal(picked, null)
})

test('时间对不上返回 null', () => {
  const match = { kickoffAt: '2026-11-02T00:30:00+08:00' }
  assert.equal(pickEvent(match, [event('e1', '2026-11-01T12:00Z', 'LIV', 'ARS')]), null)
  assert.equal(pickEvent({ kickoffAt: 'not-a-date' }, []), null)
})

test('解析首发：两队都够 11 人才算公布', () => {
  const lineup = parseEspnLineup({ rosters: [side('home'), side('away')] })
  assert.equal(lineup.home.players.length, 15)
  assert.equal(lineup.away.players.length, 15)
  assert.equal(lineup.home.formation, '4-3-3')
  assert.equal(lineup.home.confirmed, true)
  assert.equal(lineup.starters.home, 11)
  assert.equal(lineup.home.players[0].name, '首发1')
  assert.equal(lineup.home.players[0].no, 1)
})

test('阵容没公布或人数不够时不返回', () => {
  assert.equal(parseEspnLineup({ rosters: [] }), null)
  assert.equal(parseEspnLineup({ rosters: [side('home'), side('away', { starters: 6 })] }), null)
  assert.equal(parseEspnLineup({ rosters: [side('home')] }), null)
})

test('位置缩写翻成中文，替补也标出来', () => {
  const lineup = parseEspnLineup({ rosters: [side('home'), side('away')] })
  assert.equal(lineup.home.players[0].position, '中场')
  const sub = lineup.home.players.find((player) => player.starter === false)
  assert.equal(sub.position, '替补')
})

test('competitorOf 按主客取队伍', () => {
  const e = event('e1', '2026-11-01T16:30Z', 'LIV', 'ARS')
  assert.equal(competitorOf(e, 'home')?.team?.abbreviation, 'LIV')
  assert.equal(competitorOf(e, 'away')?.team?.abbreviation, 'ARS')
  assert.equal(competitorOf({}, 'home'), null)
})
