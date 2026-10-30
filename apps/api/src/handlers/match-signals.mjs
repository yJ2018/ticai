import { createTtlCache, sendData, textParam } from '../lib.mjs'
import { buildMatchSignals } from '../recommend/engine.mjs'
import { loadFinishedMatches, loadInjuries, loadSlate } from '../recommend/data.mjs'

/**
 * GET /api/match-signals?pool=ttg|had|hhad|mixed
 *
 * 投注页的「赔率接近」标注：每个玩法取赔率最低的两个选项，差值 ≤ 6% 才标；
 * 谁更被看好由推荐引擎的融合概率决定（市场 + 双方近期战绩 + 伤停）。
 *
 * 与 /api/recommendations 共用同一套读库与模型，但不跑方案和回测，响应更轻。
 */

const VALID_POOLS = new Set(['had', 'hhad', 'ttg', 'mixed'])

export function createMatchSignalHandlers(config) {
  const cache = createTtlCache({ ttlMs: 60_000, maxEntries: 6 })

  async function signals(ctx) {
    const rawPool = textParam(ctx.url, 'pool', 'mixed')
    const pool = VALID_POOLS.has(rawPool) ? rawPool : 'mixed'

    const cached = cache.get(pool)
    if (cached) {
      sendData(ctx.res, { ...cached, cache: 'hit' }, { 'x-cache': 'hit' })
      return
    }

    const slate = await loadSlate(config)
    const matchIds = slate.filter((match) => match.odds).map((match) => match.matchId)
    const [injuries, finished] = await Promise.all([
      loadInjuries(config, matchIds),
      loadFinishedMatches(config),
    ])

    const data = buildMatchSignals({ slate, injuries, finished, pool })
    cache.set(pool, data)
    sendData(ctx.res, { ...data, cache: 'miss' }, { 'x-cache': 'miss' })
  }

  return { signals }
}
