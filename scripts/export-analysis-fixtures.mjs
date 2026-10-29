/** 分析服务（Python）对拍夹具导出。
 *
 *   node scripts/export-analysis-fixtures.mjs
 *
 * 把「当前在售盘口 + 伤停 + 已结束比赛 + 回测样本」和 Node 引擎的结果一起写进
 * `apps/analysis/tests/fixtures/recommend-parity.json`；Python 测试读同一份输入，
 * 输出应当与这里的 expected 在 5e-3 内一致（概率）／完全一致（键与文案）。
 *
 * 夹具是**快照**：赔率会变，重新跑一次就是新的一天。已提交的夹具保证 CI 上
 * Node / Python 两套实现对同一批数据给出同样的结论。
 */

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { createConfig, loadEnv } from '../apps/api/src/config.mjs'
import { closePool } from '../apps/api/src/db.mjs'
import { runBacktest } from '../apps/api/src/recommend/backtest.mjs'
import {
  loadBacktestSamples,
  loadFinishedMatches,
  loadInjuries,
  loadSlate,
} from '../apps/api/src/recommend/data.mjs'
import { buildRecommendation } from '../apps/api/src/recommend/engine.mjs'

const root = resolve(import.meta.dirname, '..')
loadEnv(root)
const config = createConfig()

const NOW = new Date('2026-10-29T06:17:07.522Z')
const POOLS = ['had', 'mixed', 'ttg']

/** 只留下引擎真正读的字段，夹具别把 crs/hafu 这种用不到的赔率也塞进来 */
function trimOdds(odds, keys) {
  if (!odds || typeof odds !== 'object') {
    return null
  }
  const trimmed = {}
  for (const key of keys) {
    const value = odds[key]
    if (value && typeof value === 'object') {
      trimmed[key] = value
    }
  }
  return trimmed
}

const slate = (await loadSlate(config)).map((match) => ({
  ...match,
  odds: trimOdds(match.odds, ['had', 'hhad', 'ttg']),
}))

const matchIds = slate.filter((match) => match.odds).map((match) => match.matchId)
const injuries = await loadInjuries(config, matchIds)
const finished = await loadFinishedMatches(config)

const backtestSamples = (await loadBacktestSamples(config)).map((sample) => ({
  matchId: sample.matchId,
  matchDate: sample.matchDate,
  kickoffAt: sample.kickoffAt,
  hadResult: sample.hadResult,
  // 回测只用胜平负去水，带全套赔率只会把夹具撑大
  odds: trimOdds(sample.odds, ['had']),
}))

const expected = {}
for (const pool of POOLS) {
  expected[pool] = buildRecommendation({
    slate,
    injuries,
    finished,
    pool,
    scope: 'today',
    now: NOW,
  })
}

const fixture = {
  generatedAt: new Date().toISOString(),
  note: 'Node 引擎导出的对拍夹具；Python 版应当给出同样的方案与概率（容差 5e-3）。',
  now: NOW.toISOString(),
  slate,
  injuries: Object.fromEntries(injuries),
  finished,
  backtestSamples,
  expected,
  backtest: runBacktest(backtestSamples),
}

const target = resolve(root, 'apps/analysis/tests/fixtures/recommend-parity.json')
await writeFile(target, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')

console.log(
  `[fixtures] 写入 ${target}\n` +
    `  slate ${slate.length} 场 · 有赔率 ${slate.filter((m) => m.odds).length} · ` +
    `伤停 ${injuries.size} 场 · 历史 ${finished.length} 场 · 回测样本 ${backtestSamples.length} 场`,
)
for (const pool of POOLS) {
  const data = expected[pool]
  console.log(
    `  ${pool.padEnd(5)} 方案 ${data.plans.length} 个 · 候选 ${data.candidates.length} 场 · ` +
      `过滤 ${JSON.stringify(data.filtered)}`,
  )
}

await closePool()
