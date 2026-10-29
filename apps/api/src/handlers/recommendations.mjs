import { createTtlCache, sendData, textParam } from '../lib.mjs'
import { runBacktest } from '../recommend/backtest.mjs'
import {
  loadBacktestSamples,
  loadFinishedMatches,
  loadInjuries,
  loadSlate,
} from '../recommend/data.mjs'
import { buildRecommendation } from '../recommend/engine.mjs'

/**
 * GET /api/recommendations?pool=had|hhad|ttg|mixed&scope=today|all
 *
 * 推荐全部在服务端算：读库 → 去水 → 有界修正 → 串关风控 → 回测摘要。
 * 单实例 60 秒缓存（赔率快照本来也是分钟级），回测 10 分钟缓存。
 */

const VALID_POOLS = new Set(['had', 'hhad', 'ttg', 'mixed', 'crs', 'hafu'])

function beijingDay() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

export function createRecommendationHandlers(config) {
  const cache = createTtlCache({ ttlMs: 60_000, maxEntries: 12 })
  const backtestCache = createTtlCache({ ttlMs: 10 * 60_000, maxEntries: 1 })

  async function recommend(ctx) {
    const rawPool = textParam(ctx.url, 'pool', 'mixed')
    const pool = VALID_POOLS.has(rawPool) ? rawPool : 'mixed'
    const scope = ctx.url.searchParams.get('scope') === 'all' ? 'all' : 'today'
    const key = `${pool}:${scope}:${beijingDay()}`

    const cached = cache.get(key)
    if (cached) {
      sendData(ctx.res, { ...cached, cache: 'hit' })
      return
    }

    const slate = await loadSlate(config)
    const matchIds = slate.filter((match) => match.odds).map((match) => match.matchId)
    const [injuries, finished] = await Promise.all([
      loadInjuries(config, matchIds),
      loadFinishedMatches(config),
    ])

    const data = buildRecommendation({ slate, injuries, finished, pool, scope })

    let backtest = backtestCache.get('all')
    if (!backtest) {
      const samples = await loadBacktestSamples(config)
      backtest = runBacktest(samples)
      backtestCache.set('all', backtest)
    }

    const payload = { ...data, backtest }
    cache.set(key, payload)
    sendData(ctx.res, { ...payload, cache: 'miss' })
  }

  return { recommend }
}
