/** 开奖分析对拍夹具：Node 引擎在「截断后的真实开奖」上算出的期望结果。
 *
 *   node scripts/export-lottery-fixtures.mjs
 *
 * Python 版必须给出同样的 payload（浮点容差 1e-9）。夹具是快照：开奖新增后重跑一次即可。
 */

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { computeAnalysis, loadDraws, loadGameRow } from '../apps/api/src/analysis/compute.mjs'
import { dltConfigKey, mathTrendConfigKey, predictionConfigKey } from '../apps/api/src/analysis/configs.mjs'
import { createConfig, loadEnv } from '../apps/api/src/config.mjs'
import { closePool, query } from '../apps/api/src/db.mjs'

const root = resolve(import.meta.dirname, '..')
loadEnv(root)
const config = createConfig()
const runQuery = (text, params) => query(config, text, params)

/** 每个彩种截断多少期：夹具要小，但要足够跑完回测（默认最小训练 30 期） */
const PLAN = [
  { game: 'pl5', draws: 320, predictionOrders: [1, 2, 3, 5], mathTrend: true },
  { game: 'pl3', draws: 260, predictionOrders: [2], mathTrend: false },
  { game: 'qxc', draws: 200, predictionOrders: [2], mathTrend: false },
  { game: 'dlt', draws: 320, predictionOrders: [], mathTrend: false, dlt: true },
]

const fixture = {
  generatedAt: new Date().toISOString(),
  note: 'Node 引擎导出的开奖分析对拍夹具；Python 版应当给出同样 payload（容差 1e-9）。',
  games: {},
}

for (const item of PLAN) {
  const game = await loadGameRow(runQuery, item.game)
  if (!game) {
    console.warn(`[fixtures] 跳过 ${item.game}：彩种不存在`)
    continue
  }

  const draws = (await loadDraws(runQuery, game.game_no)).slice(0, item.draws)
  if (draws.length === 0) {
    console.warn(`[fixtures] 跳过 ${item.game}：没有开奖`)
    continue
  }

  const expected = {}
  for (const order of item.predictionOrders) {
    const configKey = predictionConfigKey({ markovOrder: order })
    const startedAt = performance.now()
    const { payload } = computeAnalysis('prediction', game, draws, configKey)
    expected[`prediction:${configKey}`] = payload
    console.log(
      `  ${item.game} prediction ${configKey} → ${Math.round(performance.now() - startedAt)}ms · ` +
        `${payload?.positions?.length ?? 0} 位`,
    )
  }

  if (item.mathTrend) {
    const configKey = mathTrendConfigKey()
    const startedAt = performance.now()
    const { payload } = computeAnalysis('math_trend', game, draws, configKey)
    expected[`math_trend:${configKey}`] = payload
    console.log(
      `  ${item.game} math_trend ${configKey} → ${Math.round(performance.now() - startedAt)}ms · ` +
        `${payload?.positions?.length ?? 0} 位`,
    )
  }

  if (item.dlt) {
    const configKey = dltConfigKey()
    const startedAt = performance.now()
    const { payload } = computeAnalysis('dlt', game, draws, configKey)
    expected[`dlt:${configKey}`] = payload
    console.log(
      `  ${item.game} dlt ${configKey} → ${Math.round(performance.now() - startedAt)}ms · ` +
        `前区 ${payload?.picks?.front?.length ?? 0} 个 / 后区 ${payload?.picks?.back?.length ?? 0} 个`,
    )
  }

  fixture.games[item.game] = {
    game: {
      gameNo: game.game_no,
      gameKey: game.game_key,
      name: game.name,
      isPositional: Boolean(game.is_positional),
      mainCount: game.main_count,
    },
    draws,
    expected,
  }
}

const target = resolve(root, 'apps/analysis/tests/fixtures/lottery-parity.json')
await writeFile(target, `${JSON.stringify(fixture)}\n`, 'utf8')
const sizeKb = (JSON.stringify(fixture).length / 1024).toFixed(0)
console.log(`[fixtures] 写入 ${target}（${sizeKb} KB）`)

await closePool()
