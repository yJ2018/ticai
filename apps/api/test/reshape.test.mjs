import assert from 'node:assert/strict'
import test from 'node:test'

import { toHistoryEnvelope, toMatchEnvelope } from '../src/reshape.mjs'

const matchRow = (overrides = {}) => ({
  sporttery_match_id: '9001',
  business_date: '2026-10-22',
  match_num_str: '周四001',
  match_time: '20:00:00',
  league_name: '英超',
  home_team_sporttery_id: '1001',
  away_team_sporttery_id: '1002',
  home_name: '阿森纳',
  away_name: '切尔西',
  odds: { had: { h: '2.10', d: '3.40', a: '3.60' } },
  ...overrides,
})

test('matches: 同一天的比赛聚成一个 businessDate 分组', () => {
  const payload = toMatchEnvelope([
    matchRow(),
    matchRow({ sporttery_match_id: '9002', match_time: '22:30:00', home_name: '曼联' }),
  ])

  assert.equal(payload.success, true)
  assert.equal(payload.value.matchInfoList.length, 1)

  const group = payload.value.matchInfoList[0]
  assert.equal(group.businessDate, '2026-10-22')
  assert.equal(group.subMatchList.length, 2)
  assert.equal(group.subMatchList[1].homeTeamAbbName, '曼联')
})

test('matches: 字段名回到体彩原始结构，bigint 转成 number', () => {
  const item = toMatchEnvelope([matchRow()]).value.matchInfoList[0].subMatchList[0]

  assert.equal(item.matchId, 9001)
  assert.equal(typeof item.matchId, 'number')
  assert.equal(item.matchNumStr, '周四001')
  assert.equal(item.leagueAllName, '英超')
  assert.equal(item.homeTeamId, 1001)
  assert.equal(item.awayTeamId, 1002)
  assert.equal(item.matchTime, '20:00:00')
  assert.equal(item.had.h, '2.10')
})

test('matches: 没有赔率时不产出空玩法字段', () => {
  const item = toMatchEnvelope([matchRow({ odds: null })]).value.matchInfoList[0].subMatchList[0]

  assert.equal('had' in item, false)
  assert.equal('hafu' in item, false)
})

test('matches: 跨天的比赛保留输入顺序', () => {
  const payload = toMatchEnvelope([
    matchRow({ business_date: '2026-10-22' }),
    matchRow({ sporttery_match_id: '9002', business_date: '2026-10-23' }),
    matchRow({ sporttery_match_id: '9003', business_date: '2026-10-23' }),
  ])

  const dates = payload.value.matchInfoList.map((group) => group.businessDate)
  assert.deepEqual(dates, ['2026-10-22', '2026-10-23'])
  assert.equal(payload.value.matchInfoList[1].subMatchList.length, 2)
})

test('matches: 空结果仍然返回合法信封', () => {
  const payload = toMatchEnvelope([])
  assert.deepEqual(payload.value.matchInfoList, [])
  assert.equal(payload.success, true)
})

test('history: 分页信息按 total 计算', () => {
  const payload = toHistoryEnvelope({
    draws: [
      {
        id: '11',
        issue: '26280',
        draw_date: '2026-10-21',
        numbers_text: '8 6 4',
        sales_amount: '43532588.00',
        pool_balance: null,
      },
    ],
    levels: [
      {
        draw_id: '11',
        prize_key: '直选',
        sort_no: 10,
        stake_count: '12375',
        prize_amount: '1040.00',
        total_amount: '12870000.00',
      },
    ],
    pageNo: 2,
    pageSize: 100,
    total: 7755,
    gameName: '排列3',
  })

  assert.equal(payload.value.pageNo, 2)
  assert.equal(payload.value.pageSize, 100)
  assert.equal(payload.value.total, 7755)
  assert.equal(payload.value.pages, 78)
})

test('history: 金额同时输出上游真名与历史字段（修复前端显示 --）', () => {
  const item = toHistoryEnvelope({
    draws: [
      {
        id: '11',
        issue: '26280',
        draw_date: '2026-10-21',
        numbers_text: '8 6 4',
        sales_amount: '43532588.00',
        pool_balance: '0.00',
      },
    ],
    levels: [],
    pageNo: 1,
    pageSize: 30,
    total: 1,
  }).value.list[0]

  assert.equal(item.totalSaleAmount, '43532588')
  assert.equal(item.lotterySaleAmount, '43532588')
  assert.equal(item.poolBalance, '0')
  assert.equal(item.poolAmount, '0')
  assert.equal(item.lotteryDrawNum, '26280')
  assert.equal(item.lotteryDrawResult, '8 6 4')
})

test('history: 奖级按 sort 升序，一等奖在前', () => {
  const item = toHistoryEnvelope({
    draws: [
      {
        id: '12',
        issue: '26120',
        draw_date: '2026-10-21',
        numbers_text: '01 06 10 15 32 03 04',
        sales_amount: null,
        pool_balance: null,
      },
    ],
    levels: [
      { draw_id: '12', prize_key: '二等奖', sort_no: 301, stake_count: '73', prize_amount: '303750', total_amount: '22173750' },
      { draw_id: '12', prize_key: '一等奖', sort_no: 101, stake_count: '3', prize_amount: '10000000', total_amount: '30000000' },
    ],
    pageNo: 1,
    pageSize: 30,
    total: 1,
    gameName: '超级大乐透',
  }).value.list[0]

  assert.deepEqual(
    item.prizeLevelList.map((level) => level.prizeLevel),
    ['一等奖', '二等奖'],
  )
})

test('history: 空页返回 total 0 且 pages 至少为 1', () => {
  const payload = toHistoryEnvelope({ draws: [], levels: [], pageNo: 1, pageSize: 30, total: 0 })
  assert.deepEqual(payload.value.list, [])
  assert.equal(payload.value.total, 0)
  assert.equal(payload.value.pages, 1)
})
