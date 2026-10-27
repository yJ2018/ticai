import assert from 'node:assert/strict'
import test from 'node:test'

import {
  mathTrendConfigKey,
  parseMathTrendConfigKey,
  parsePredictionConfigKey,
  predictionConfigKey,
  presetsForGame,
} from '../src/analysis/configs.mjs'
import { computeAnalysis, refreshSnapshots } from '../src/analysis/compute.mjs'

/* ── 夹具 ─────────────────────────────────────────────── */

const PL5 = {
  game_no: '350133',
  game_key: 'pl5',
  name: '排列5',
  is_positional: true,
  digit_count: 5,
  main_count: 5,
  extra_count: 0,
}

const QXC = {
  game_no: '04',
  game_key: 'qxc',
  name: '七星彩',
  is_positional: true,
  digit_count: 7,
  main_count: 7,
  extra_count: 0,
}

const DLT = {
  game_no: '85',
  game_key: 'dlt',
  name: '超级大乐透',
  is_positional: false,
  digit_count: null,
  main_count: 5,
  extra_count: 2,
}

/** 稳定伪随机，避免测试因为随机号码而时好时坏 */
function lcg(seed) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

/** 生成「最新在前」的开奖行，和 compute.mjs 里 DRAWS_SQL 的排序一致 */
function makeDraws(count, { positional = true, seed = 7 } = {}) {
  const random = lcg(seed)
  return Array.from({ length: count }, (_, index) => {
    const seq = 26000 - index
    const numbers = positional
      ? Array.from({ length: 5 }, () => Math.floor(random() * 10))
      : [
          ...Array.from({ length: 5 }, () => 1 + Math.floor(random() * 35)),
          ...Array.from({ length: 2 }, () => 1 + Math.floor(random() * 12)),
        ]
    return {
      issue: String(seq),
      issue_seq: String(seq),
      draw_date: new Date(Date.UTC(2026, 9, 26 - index)).toISOString().slice(0, 10),
      main_numbers: positional ? numbers : numbers.slice(0, 5),
      extra_numbers: positional ? [] : numbers.slice(5),
    }
  })
}

/** 把库里的一行变成 compute.mjs 里 loadDraws 的返回形状 */
const toDraw = (row) => ({
  issue: row.issue,
  issueSeq: Number(row.issue_seq),
  drawDate: row.draw_date,
  numbers: [...row.main_numbers, ...row.extra_numbers].map(String),
})

const SQL = {  game: /select game_no, game_key, name, is_positional/,
  draws: /select\s+issue,\s+issue_seq,\s+to_char\(draw_date/,
  latestDraw: /order by issue_seq desc\s+limit 1/,
  stored: /from lottery_analysis_latest/,
  upsert: /insert into lottery_analysis_snapshot/,
}

/**
 * 只认识本模块用到的几条 SQL 的假数据库。
 * 目的不是模拟 PG，而是把「什么时候算、算了几个、写了什么溯源」测出来。
 */
function createFakeDb({ game, draws, stored = [] }) {
  const inserts = []
  const queries = []

  const runQuery = async (text, params) => {
    const sql = String(text).replace(/\s+/g, ' ').trim()
    queries.push(sql)

    if (SQL.game.test(sql)) {
      return { rows: params[0] === game.game_no || params[0] === game.game_key ? [game] : [] }
    }
    if (SQL.latestDraw.test(sql)) {
      return { rows: draws.slice(0, 1) }
    }
    if (SQL.draws.test(sql)) {
      return { rows: draws }
    }
    if (SQL.stored.test(sql)) {
      return { rows: stored }
    }
    if (SQL.upsert.test(sql)) {
      if (sql.includes('unnest')) {
        // 批量写入：参数是 15 个列数组，这里转回「一行一个数组」方便断言
        const rowCount = params[0].length
        for (let index = 0; index < rowCount; index += 1) {
          inserts.push(params.map((column) => column[index]))
        }
      } else {
        inserts.push(params)
      }
      return { rows: [{ id: inserts.length, computed_at: new Date() }] }
    }
    throw new Error(`假数据库不认识这条 SQL：${sql.slice(0, 60)}…`)
  }

  return { runQuery, inserts, queries }
}

/* ── 配置指纹 ─────────────────────────────────────────── */

test('configKey: 默认权重不进 key，自定义权重要能还原', () => {
  assert.equal(predictionConfigKey({ markovOrder: 3 }), 'markov=3')
  assert.deepEqual(parsePredictionConfigKey('markov=3'), { markovOrder: 3 })

  const custom = predictionConfigKey({
    markovOrder: 2,
    scoreWeights: { recent: 0.3, long: 0.2, omission: 0.2, transition: 0.15, pairTransition: 0.15 },
  })
  assert.equal(custom, 'markov=2;w=30-20-20-15-15')

  const parsed = parsePredictionConfigKey(custom)
  assert.equal(parsed.markovOrder, 2)
  assert.equal(parsed.scoreWeights.recent, 0.3)
  assert.equal(parsed.scoreWeights.pairTransition, 0.15)
})

test('configKey: 越界参数夹紧，不会产生无法复现的 key', () => {
  assert.equal(predictionConfigKey({ markovOrder: 99 }), 'markov=5')
  assert.equal(predictionConfigKey({ markovOrder: 0 }), 'markov=1')
  assert.equal(mathTrendConfigKey({ sampleWindow: 9999 }), 'window=400;trend=36;validate=120;candidates=3')
  assert.deepEqual(parseMathTrendConfigKey('window=200;trend=30;validate=100;candidates=2'), {
    sampleWindow: 200,
    trendWindow: 30,
    validationStart: 100,
    candidateCount: 2,
  })
})

test('presets: 位置型彩种预算 5 个阶数 + 数学走势，大乐透只预算 5+2', () => {
  const positional = presetsForGame(PL5)
  assert.equal(positional.length, 6)
  assert.deepEqual(
    positional.slice(0, 5).map((item) => item.configKey),
    ['markov=1', 'markov=2', 'markov=3', 'markov=4', 'markov=5'],
  )
  assert.equal(positional[5].kind, 'math_trend')

  const dlt = presetsForGame(DLT)
  assert.equal(dlt.length, 1)
  assert.equal(dlt[0].kind, 'dlt')
})

/* ── 纯计算 + 溯源 ────────────────────────────────────── */

test('computeAnalysis: 排列五用全量样本，溯源指向最后一期', () => {
  const draws = makeDraws(120).map(toDraw)
  const { payload, sample } = computeAnalysis('prediction', PL5, draws, 'markov=2')

  assert.equal(payload.sampleSize, 120)
  assert.equal(payload.positions.length, 5)
  assert.equal(payload.positions[0].candidates.length, 5)
  assert.equal(sample.throughIssue, draws[0].issue)
  assert.equal(sample.throughDrawDate, draws[0].drawDate)
  assert.equal(sample.fromIssue, draws[119].issue)
  assert.equal(sample.drawCount, 120)
})

test('computeAnalysis: 七星彩按 7 位算，第 7 位的两位数号码不会把整期丢掉', () => {
  const draws = makeDraws(120)
    .map((draw, index) => ({
      ...draw,
      // 七星彩末位可以是 10–14，前端 parseDigitValue 会把它当无效位
      main_numbers: [1, 2, 3, 4, 5, 6, index % 3 === 0 ? 11 : 9],
    }))
    .map(toDraw)
  const { payload } = computeAnalysis('prediction', QXC, draws, 'markov=2')

  assert.equal(payload.positions.length, 7)
  assert.ok(payload.positions[6].historySample < 120, '末位应过滤掉两位数号码')
  assert.ok(payload.positions[0].historySample === 120, '前六位不应受影响')
})

test('computeAnalysis: 数学走势按窗口截断，drawCount 反映真正吃进样本的期数', () => {
  const draws = makeDraws(400).map(toDraw)
  const { payload, sample } = computeAnalysis('math_trend', PL5, draws, mathTrendConfigKey())

  assert.equal(payload.sampleSize, 400)
  assert.equal(payload.effectiveSampleWindow, 240)
  assert.equal(sample.drawCount, 240)
  assert.equal(sample.fromIssue, draws[239].issue)
})

test('computeAnalysis: 大乐透推演只取最近 300 期', () => {
  const draws = makeDraws(420, { positional: false }).map(toDraw)
  const { payload, sample } = computeAnalysis('dlt', DLT, draws, 'window=300')

  assert.ok(payload, '样本充足时应给出推演')
  assert.equal(payload.picks.front.length, 5)
  assert.equal(payload.picks.back.length, 2)
  assert.equal(payload.windows.long, 300)
  assert.equal(sample.drawCount, 300)
})

test('computeAnalysis: 样本不足时返回 null，而不是写入半截结果', () => {
  const draws = makeDraws(10, { positional: false }).map(toDraw)
  const { payload, sample } = computeAnalysis('dlt', DLT, draws, 'window=300')
  assert.equal(payload, null)
  assert.equal(sample, null)
})

/* ── 事件：开奖后重算 + 幂等 ──────────────────────────── */

test('refreshSnapshots: 一次性把 6 个组合算出来并写入溯源', async () => {
  const draws = makeDraws(130)
  const { runQuery, inserts } = createFakeDb({ game: PL5, draws })

  const result = await refreshSnapshots({ runQuery, gameKey: 'pl5', source: 'crawler', crawlRunId: 42 })

  assert.equal(result.results.length, 6)
  assert.ok(result.results.every((item) => item.status === 'computed'))
  assert.equal(inserts.length, 6)

  const [gameNo, kind, configKey, throughIssue, throughSeq, throughDate, fromIssue, , , drawCount] = inserts[0]
  assert.equal(gameNo, '350133')
  assert.equal(kind, 'prediction')
  assert.equal(configKey, 'markov=1')
  assert.equal(throughIssue, draws[0].issue)
  assert.equal(Number(throughSeq), Number(draws[0].issue_seq))
  assert.equal(throughDate, draws[0].draw_date)
  assert.equal(fromIssue, draws[129].issue)
  assert.equal(drawCount, 130)

  const payload = JSON.parse(inserts[0][10])
  assert.equal(payload.positions.length, 5)
  const meta = JSON.parse(inserts[0][11])
  assert.equal(meta.gameKey, 'pl5')
  assert.ok(meta.engineDigest, 'meta 里要带算法指纹')
})

test('refreshSnapshots: 同一期重复触发只查库不重算（爬虫每 30 分钟抓一次不能白烧 CPU）', async () => {
  const draws = makeDraws(130)
  const stored = ['markov=1', 'markov=2', 'markov=3', 'markov=4', 'markov=5'].map((configKey) => ({
    kind: 'prediction',
    config_key: configKey,
    through_issue_seq: draws[0].issue_seq,
  }))
  stored.push({ kind: 'math_trend', config_key: mathTrendConfigKey(), through_issue_seq: draws[0].issue_seq })

  const { runQuery, inserts } = createFakeDb({ game: PL5, draws, stored })
  const result = await refreshSnapshots({ runQuery, gameKey: 'pl5' })

  assert.equal(inserts.length, 0)
  assert.equal(result.results.filter((item) => item.status === 'skipped').length, 6)
})

test('refreshSnapshots: 落后一期时只补算，不整体重跑', async () => {
  const draws = makeDraws(130)
  const stale = ['markov=1', 'markov=2', 'markov=3', 'markov=4', 'markov=5'].map((configKey) => ({
    kind: 'prediction',
    config_key: configKey,
    through_issue_seq: String(Number(draws[0].issue_seq) - 1),
  }))
  stale.push({ kind: 'math_trend', config_key: mathTrendConfigKey(), through_issue_seq: draws[0].issue_seq })

  const { runQuery, inserts } = createFakeDb({ game: PL5, draws, stored: stale })
  const result = await refreshSnapshots({ runQuery, gameKey: 'pl5' })

  assert.equal(inserts.length, 5)
  assert.equal(result.results.filter((item) => item.status === 'skipped').length, 1)
  assert.ok(inserts.every((params) => params[2].startsWith('markov=')))
})

test('refreshSnapshots: --force 时即使已最新也重算', async () => {
  const draws = makeDraws(60, { positional: false })
  const stored = [{ kind: 'dlt', config_key: 'window=300', through_issue_seq: draws[0].issue_seq }]
  const { runQuery, inserts } = createFakeDb({ game: DLT, draws, stored })

  await refreshSnapshots({ runQuery, gameKey: 'dlt', force: true })
  assert.equal(inserts.length, 1)
  assert.equal(inserts[0][1], 'dlt')
})
