import {
  HttpError,
  clientIpFor,
  createRateLimiter,
  intParam,
  sendJson,
  textParam,
} from '../lib.mjs'
import { getMatches } from '../repos/matches.mjs'
import { getHistoryBulk, getHistoryPage } from '../repos/lottery.mjs'

/**
 * 体彩相关接口：从库读，输出保持 upstream 信封。
 *
 * ⚠️ 与旧 BFF 的行为差异：
 * - /api/matches 忽略 poolType：库里存了全部玩法，一次返回即可，
 *   前端按 poolType 自己取（省掉 5 次请求、5 份重复数据）；
 * - /api/history 的 gameNo 现在支持 game_no（350133）和 game_key（pl5）两种写法。
 */

const POOL_TYPES = new Set(['had', 'crs', 'ttg', 'hafu', 'mixed'])
const TRUST_PROXY = process.env.TRUST_PROXY !== '0'

export function createSportteryHandlers(config) {
  // 全量开奖一次 45 KB（gzip），比逐页翻小一个数量级；给个宽松的 IP 限流防止被刷
  const bulkLimiter = createRateLimiter({ limit: 30 })
  async function matches(ctx) {
    const poolType = textParam(ctx.url, 'poolType', 'mixed') || 'mixed'
    if (!POOL_TYPES.has(poolType)) {
      throw new HttpError(400, `不支持的玩法池：${poolType}`)
    }

    const { payload, cache, dataAsOf, count } = await getMatches(config)

    sendJson(ctx.res, 200, payload, {
      'x-cache': cache,
      'x-match-count': String(count),
      ...(dataAsOf ? { 'x-data-as-of': dataAsOf } : {}),
    })
  }

  async function history(ctx) {
    const gameNo = textParam(ctx.url, 'gameNo')
    // 兼容 350133 / 35 / 04 / 85 与 pl5 / pl3 / dlt / qxc
    if (!/^[0-9a-z]{2,8}$/i.test(gameNo)) {
      throw new HttpError(400, 'gameNo 参数不合法')
    }

    const pageNo = intParam(ctx.url, 'pageNo', 1, { min: 1, max: 10_000 })
    const pageSize = intParam(ctx.url, 'pageSize', 30, { min: 1, max: 100 })

    const { payload, cache, timings } = await getHistoryPage(config, { gameNo, pageNo, pageSize })
    const headers = { 'x-cache': cache }

    // 浏览器 Network → Timing 里能直接看到 db / resolve / reshape 各占多少
    if (timings) {
      headers['server-timing'] = [
        `cache;desc=${cache}`,
        `db;dur=${timings.query.toFixed(1)}`,
        `resolve;dur=${timings.resolve.toFixed(1)}`,
        `reshape;dur=${timings.reshape.toFixed(1)}`,
        `app;dur=${timings.total.toFixed(1)}`,
      ].join(', ')
    }

    sendJson(ctx.res, 200, payload, headers)
  }

  /**
   * 全量开奖（紧凑）。
   *
   * 分析结果本身由 /api/analysis/lottery 直出快照；这个接口只服务「用户在分析页
   * 拖权重滑块」这类连续参数场景——预算不了，只能把全量号码取到本地重算。
   */
  async function historyBulk(ctx) {
    const gameNo = textParam(ctx.url, 'gameNo') || textParam(ctx.url, 'game')
    if (!/^[0-9a-z]{2,8}$/i.test(gameNo)) {
      throw new HttpError(400, 'gameNo 参数不合法')
    }

    bulkLimiter(clientIpFor(ctx.req, { trustProxy: TRUST_PROXY }))

    const { payload, cache, count, queryMs } = await getHistoryBulk(config, { gameNo })

    sendJson(ctx.res, 200, payload, {
      'x-cache': cache,
      'x-draw-count': String(count),
      'cache-control': 'public, max-age=300, s-maxage=600',
      'server-timing': `cache;desc=${cache},db;dur=${queryMs.toFixed(1)}`,
    })
  }

  return { matches, history, historyBulk }
}