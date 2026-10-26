import { intParam, readJsonBody, sendData, sendJson, textParam } from '../lib.mjs'
import { createBet, deleteBet, getBet, getBetStats, listBets } from '../repos/bets.mjs'
import { requireSession } from '../session.mjs'

/**
 * 我的投注：全部接口都要登录。
 *
 *   GET    /api/bets?limit=&offset=&pool=   列表（含实时结算状态）
 *   GET    /api/bets/stats                  顶部统计
 *   POST   /api/bets                        保存一份投注单
 *   GET    /api/bets/:id                    详情
 *   DELETE /api/bets/:id                    删除
 */
export function createBetHandlers(config) {
  async function list(ctx) {
    const session = await requireSession(config, ctx.req)
    const limit = intParam(ctx.url, 'limit', 30, { min: 1, max: 100 })
    const offset = intParam(ctx.url, 'offset', 0, { min: 0, max: 10_000 })
    const pool = textParam(ctx.url, 'pool', '')

    const items = await listBets(config, session.user.id, { limit, offset, pool })
    const stats = offset === 0 ? await getBetStats(config, session.user.id) : null

    sendData(ctx.res, { items, stats, limit, offset })
  }

  async function stats(ctx) {
    const session = await requireSession(config, ctx.req)
    sendData(ctx.res, await getBetStats(config, session.user.id))
  }

  async function create(ctx) {
    const session = await requireSession(config, ctx.req)
    const body = await readJsonBody(ctx.req, { maxBytes: 128 * 1024 })
    const bet = await createBet(config, session.user.id, body)
    sendJson(ctx.res, 201, { success: true, data: bet })
  }

  async function detail(ctx) {
    const session = await requireSession(config, ctx.req)
    sendData(ctx.res, await getBet(config, session.user.id, ctx.params.id))
  }

  async function remove(ctx) {
    const session = await requireSession(config, ctx.req)
    sendData(ctx.res, await deleteBet(config, session.user.id, ctx.params.id))
  }

  return { list, stats, create, detail, remove }
}
