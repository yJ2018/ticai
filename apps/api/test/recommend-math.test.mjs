import assert from 'node:assert/strict'
import test from 'node:test'

import {
  devig,
  fitLambdas,
  parseGoalLine,
  poissonPmf,
  poolProbabilities,
  scoreMatrix,
} from '../src/recommend/math.mjs'

const close = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}（容差 ${tolerance}）`)

test('泊松：概率和为 1，均值接近 λ', () => {
  const pmf = poissonPmf(1.7, 8)
  const total = pmf.reduce((sum, value) => sum + value, 0)
  close(total, 1, 1e-3)
  const mean = pmf.reduce((sum, value, index) => sum + value * index, 0)
  close(mean, 1.7, 0.02)
})

test('去水：公平赔率还原成 50%，含水赔率概率和为 1', () => {
  close(devig([2, 2])[0], 0.5)
  const probs = devig([1.9, 3.4, 4.2])
  close(probs.reduce((sum, value) => sum + value, 0), 1, 1e-9)
  assert.ok(probs[0] > probs[1] && probs[1] > probs[2])
})

test('去水：幂法把长赔的概率压得比比例归一更低（避免系统性高估冷门）', () => {
  const odds = [1.35, 4.8, 9.5]
  const power = devig(odds)
  const raw = odds.map((value) => 1 / value)
  const total = raw.reduce((left, right) => left + right, 0)
  const proportional = raw.map((value) => value / total)

  assert.ok(power[0] > proportional[0], '热门应被抬高')
  assert.ok(power[2] < proportional[2], '冷门应被压低')
})

test('让球线解析："+1" / "-1" / 空串', () => {
  assert.equal(parseGoalLine('+1'), 1)
  assert.equal(parseGoalLine('-1'), -1)
  assert.equal(parseGoalLine(''), 0)
  assert.equal(parseGoalLine('+1.00'), 1)
})

test('比分矩阵：Dixon-Coles 修正后仍归一，且低比分被抬高', () => {
  const matrix = scoreMatrix(1.4, 1.1)
  const total = matrix.flat().reduce((sum, value) => sum + value, 0)
  close(total, 1, 1e-9)

  const plain = scoreMatrix(1.4, 1.1, { rho: 0 })
  assert.ok(matrix[0][0] > plain[0][0], '0:0 应被 rho 抬高')
  assert.ok(matrix[1][0] < plain[1][0], '1:0 应被压低')
})

test('玩法概率：胜平负和为 1，让球 +1 抬高主胜，总进球 7+ 有尾巴', () => {
  const matrix = scoreMatrix(1.5, 1.1)
  const probs = poolProbabilities(matrix, 1)

  const hadTotal = probs.had.h + probs.had.d + probs.had.a
  close(hadTotal, 1, 1e-9)

  const plain = poolProbabilities(matrix, 0)
  assert.ok(probs.hhad.h > plain.hhad.h, '让球 +1 后主胜概率应更高')
  assert.ok(probs.ttg.s7 > 0)
})

test('反推 λ：用已知 λ 生成的分布能拟合回来', () => {
  const truth = { home: 1.65, away: 1.05 }
  const matrix = scoreMatrix(truth.home, truth.away)
  const probs = poolProbabilities(matrix, 0)

  const fit = fitLambdas({ hadTarget: probs.had, ttgTarget: probs.ttg, goalLine: 0 })
  assert.ok(fit, '应能拟合出 λ')
  close(fit.home, truth.home, 0.12)
  close(fit.away, truth.away, 0.12)
})

test('反推 λ：没有市场概率时返回 null', () => {
  assert.equal(fitLambdas({ hadTarget: null, ttgTarget: null }), null)
})
