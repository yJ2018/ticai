import { HttpError, intParam, sendJson, textParam } from '../lib.mjs'
import { getMatches } from '../repos/matches.mjs'
import { getHistoryPage } from '../repos/lottery.mjs'

/**
 * 体彩相关接口：从库读，输出保持 upstream 信封。
 *
 * ⚠️ 与旧 BFF 的行为差异：
 * - /api/matches 忽略 poolType：库里存了全部玩法，一次返回即可，
 *   前端按 poolType 自己取（省掉 5 次请求、5 份重复数据）；
 * - /api/history 的 gameNo 现在支持 game_no（350133）和 game_key（pl5）两种写法。
 */

const POOL_TYPES = new Set(['had', 'crs', 'ttg', 'hafu', 'mixed'])

export function createSportteryHandlers(config) {
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

    const { payload, cache } = await getHistoryPage(config, { gameNo, pageNo, pageSize })
    sendJson(ctx.res, 200, payload, { 'x-cache': cache })
  }

  return { matches, history }
}
