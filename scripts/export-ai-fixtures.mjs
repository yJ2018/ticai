/** AI 分析提示词对拍夹具：Node 版在同一条真实比赛数据上构建的提示词。
 *
 *   node scripts/export-ai-fixtures.mjs
 *
 * Python 版必须产出逐字节相同的 system / user / chars。LLM 输出本身不参与对拍。
 */

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { loadMatchContext } from '../apps/api/src/ai/context.mjs'
import { formatKickoff, loadParlayContext } from '../apps/api/src/ai/parlay-context.mjs'
import { buildParlayPrompt, describeLegOdds, formatInjuryBrief } from '../apps/api/src/ai/parlay-prompt.mjs'
import { buildAnalysisPrompt } from '../apps/api/src/ai/prompt.mjs'
import { createConfig, loadEnv } from '../apps/api/src/config.mjs'
import { closePool, query } from '../apps/api/src/db.mjs'

const root = resolve(import.meta.dirname, '..')
loadEnv(root)
const config = createConfig()
const runQuery = (text, params) => query(config, text, params)

const POOLS = ['had', 'crs', 'ttg', 'hafu', 'mixed']

const weather = {
  available: true,
  city: 'Manchester',
  country: 'United Kingdom',
  current: {
    temperature: 10.9,
    apparentTemperature: 9.4,
    humidity: 81,
    precipitation: 0.2,
    windSpeed: 4.7,
    windDirection: 210,
    weather: '阴',
    weatherCode: 3,
    time: '2026-10-29T12:00',
  },
  daily: [],
  kickoff: { time: '2026-10-31T15:00', forecastTime: '2026-10-31T15:00', temperature: 12, precipitationProbability: 35, weather: '小雨', windSpeed: 5.1 },
  source: 'open-meteo',
}

const candidateResult = await runQuery(
  `select m.sporttery_match_id
   from match m
   where exists (select 1 from match_feed f where f.sporttery_match_id = m.sporttery_match_id and f.feed = 'injury')
     and exists (select 1 from match_odds_snapshot s where s.match_id = m.id)
   order by m.kickoff_at desc
   limit 5`,
)
const candidates = candidateResult.rows ?? []
if (candidates.length === 0) {
  console.error('[fixtures] 找不到带伤停与赔率的比赛，先跑一次爬虫')
  process.exit(1)
}

let context = null
let matchId = null
for (const row of candidates) {
  const candidate = await loadMatchContext(config, Number(row.sporttery_match_id))
  if (candidate && candidate.odds && Object.keys(candidate.feeds).length > 0) {
    context = candidate
    matchId = Number(row.sporttery_match_id)
    break
  }
}
if (!context) {
  console.error('[fixtures] 候选比赛都没有完整上下文')
  process.exit(1)
}

const single = {}
for (const pool of POOLS) {
  single[pool] = buildAnalysisPrompt({ ...context, weather: null, pool })
}
const singleWithWeather = buildAnalysisPrompt({ ...context, weather, pool: 'mixed' })

// 串关：用真实上下文拼两场（一场带本地缓存分析），验证 formatLeg / header 完全一致
const parlayContext = await loadParlayContext(config, [matchId])
const found = parlayContext.get(String(matchId))
const legs = [
  {
    order: 1,
    matchNo: found?.match?.match_num_str ?? '',
    teams: `${found?.match?.home_name ?? ''} vs ${found?.match?.away_name ?? ''}`,
    league: found?.match?.league_name ?? '未知赛事',
    kickoff: formatKickoff(found?.match?.kickoff_at) || '未知时间',
    selected: '总进球 2（3.40）、总进球 3（3.60）',
    odds: found ? describeLegOdds(found.odds, 'ttg') : '',
    injuries: found
      ? formatInjuryBrief({ injury: found.injury ?? {} }, found.match.home_name, found.match.away_name)
      : '',
    cachedAnalysis:
      '【分析】1. 状态与风格：主队近 5 场 3 胜 1 平 1 负，主场强势。2. 伤停：暂无可靠伤停信息。3. 主客场与赛程：连续主场，体能占优。4. 天气影响：小雨，节奏可能放缓。5. 赔率解读：总进球 2-3 球赔率偏低，市场倾向中低比分。【预测】推荐选项：总进球 2-3 球；比分参考：1:1；信心等级：中；理由：双方节奏偏慢。以上为 AI 分析，仅供参考，不构成投注建议。',
  },
  {
    order: 2,
    matchNo: '周四002',
    teams: '国际图尔 vs 赫尔辛基',
    league: '芬兰超级联赛',
    kickoff: '10-29 16:00',
    selected: '胜平负 平（3.40）',
    odds: '胜平负 胜2.10 平3.40 负3.05',
    injuries: '',
    cachedAnalysis: '',
  },
]

const parlay = buildParlayPrompt({
  pool: 'ttg',
  passSummaryText: '2串1',
  betAmount: 200,
  maxBonus: 734.4,
  legs,
})

const fixture = {
  generatedAt: new Date().toISOString(),
  note: 'Node 版 AI 提示词对拍夹具；Python 版必须逐字节一致（LLM 输出不参与对拍）。',
  matchId,
  context,
  weather,
  single,
  singleWithWeather,
  parlay: { input: { pool: 'ttg', passSummaryText: '2串1', betAmount: 200, maxBonus: 734.4, legs }, ...parlay },
}

const target = resolve(root, 'apps/analysis/tests/fixtures/ai-prompt-parity.json')
await writeFile(target, `${JSON.stringify(fixture)}\n`, 'utf8')
console.log(
  `[fixtures] 写入 ${target}（${(JSON.stringify(fixture).length / 1024).toFixed(0)} KB）· match ${matchId} · ` +
    `user ${single.mixed.chars} 字符 · parlay ${parlay.chars} 字符`,
)

await closePool()
