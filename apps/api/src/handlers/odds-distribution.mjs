import { createTtlCache, sendData } from '../lib.mjs'
import { getTtgResultCoverage, listTtgOddsSamples } from '../repos/results.mjs'
import { buildTtgOddsDistribution } from '../ttg-distribution.mjs'

/**
 * GET /api/odds-distribution
 *
 * 开奖记录 × 总进球赔率：不限时间，把库里所有「已开奖 + 赛前有 TTG 赔率」的场次
 * 聚合成最低 / 倒数第二低 / 第三低 / 中奖赔率四条分布，并给出中奖赔率的排名分布。
 *
 * 读的是只读库；聚合本身很轻（当前百场级），单实例缓存 5 分钟，
 * 爬虫每 30 分钟补一次赛果，足够新鲜。
 */

export function createOddsDistributionHandlers(config) {
  const cache = createTtlCache({ ttlMs: 5 * 60_000, maxEntries: 2 })

  async function ttg(ctx) {
    const cached = cache.get('ttg')
    if (cached) {
      sendData(ctx.res, { ...cached, cache: 'hit' }, { 'x-ttg-samples': String(cached.sample.matches) })
      return
    }

    const [rows, coverage] = await Promise.all([
      listTtgOddsSamples(config),
      getTtgResultCoverage(config),
    ])

    const data = buildTtgOddsDistribution(rows, {
      settledResults: coverage.total,
      updatedAt: coverage.updatedAt,
      recentLimit: 15,
    })

    cache.set('ttg', data)
    sendData(ctx.res, { ...data, cache: 'miss' }, { 'x-ttg-samples': String(data.sample.matches) })
  }

  return { ttg }
}
