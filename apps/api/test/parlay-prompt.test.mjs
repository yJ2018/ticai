import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildParlayPrompt, formatInjuryBrief } from '../src/ai/parlay-prompt.mjs'

const baseLeg = {
  order: 1,
  matchNo: '周四006',
  teams: '伯恩茅斯 vs AC米兰',
  league: '欧罗巴',
  kickoff: '10-23 03:00',
  selected: '2球（3.85）',
  odds: '总进球: 0球 9.00 | 1球 4.20 | 2球 3.85',
  injuries: '伯恩茅斯 甲伤、乙伤｜AC米兰 丙伤',
  cachedAnalysis: '',
}

test('串关提示词：包含方案概况与逐场选择', () => {
  const prompt = buildParlayPrompt({
    pool: 'ttg',
    passSummaryText: '2串1',
    betAmount: 20,
    maxBonus: 123.4,
    legs: [baseLeg, { ...baseLeg, order: 2, matchNo: '周四007', teams: '凯尔特人 vs 塞尔塔' }],
  })

  assert.equal(prompt.chars, prompt.user.length)
  assert.ok(prompt.system.includes('【总评】'))
  assert.ok(prompt.user.includes('2串1，共 2 场'))
  assert.ok(prompt.user.includes('投注金额 20 元'))
  assert.ok(prompt.user.includes('理论最高奖金 123.4 元'))
  assert.ok(prompt.user.includes('第1场｜周四006'))
  assert.ok(prompt.user.includes('第2场｜周四007'))
  assert.ok(prompt.user.includes('当前选择：2球（3.85）'))
  assert.ok(prompt.user.includes('市场赔率：总进球'))
  assert.ok(prompt.user.includes('伤停：伯恩茅斯'))
  assert.ok(prompt.user.includes('当前玩法：总进球数'))
})

test('串关提示词：空字段不产生空行', () => {
  const prompt = buildParlayPrompt({
    pool: 'had',
    passSummaryText: '',
    betAmount: 0,
    maxBonus: 0,
    legs: [{ ...baseLeg, odds: '', injuries: '', selected: '主胜（1.85）' }],
  })

  assert.ok(prompt.user.includes('未选择过关方式'))
  assert.ok(!prompt.user.includes('市场赔率：'))
  assert.ok(!prompt.user.includes('伤停：'))
  assert.ok(prompt.user.includes('主胜（1.85）'))
})

test('串关提示词：本地缓存分析会带上并标注可复用', () => {
  const prompt = buildParlayPrompt({
    pool: 'crs',
    passSummaryText: '单关',
    betAmount: 10,
    maxBonus: 85,
    legs: [{ ...baseLeg, cachedAnalysis: '上一轮判断主队会收缩防守。' }],
  })

  assert.ok(prompt.user.includes('本地缓存分析（3 小时内，可直接复用，不要重复分析）：上一轮判断主队会收缩防守。'))
})

test('伤停简述：每队最多两人，禁赛标记为「停」', () => {
  const brief = formatInjuryBrief(
    {
      injury: {
        home: {
          injuriesAndSuspensionsList: [
            { personName: '甲', suspensionFlag: 0 },
            { personName: '乙', suspensionFlag: 1 },
            { personName: '丙', suspensionFlag: 0 },
          ],
        },
        away: { injuriesAndSuspensionsList: [] },
      },
    },
    '主队',
    '客队',
  )

  assert.equal(brief, '主队 甲伤、乙停')
})
