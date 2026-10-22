import { query } from '../db.mjs'
import { HttpError, createTtlCache } from '../lib.mjs'
import { toHistoryEnvelope } from '../reshape.mjs'

/**
 * 开奖历史：库 → 体彩分页信封。
 *
 * 分页仍用 offset：前端每页 30 条、最多翻到第 78 页，这个量级 offset 无感。
 * 将来要"无限滚动"再换 keyset（issue_seq 游标）。
 */

const cache = createTtlCache({ ttlMs: 60_000, maxEntries: 200 })

const DRAW_SQL = `
  select
    d.id,
    d.issue,
    to_char(d.draw_date, 'YYYY-MM-DD') as draw_date,
    d.numbers_text,
    d.sales_amount,
    d.pool_balance,
    count(*) over () as total
  from lottery_draw d
  where d.game_no = $1
  order by d.issue_seq desc
  limit $2 offset $3
`

const LEVEL_SQL = `
  select draw_id, prize_key, sort_no, stake_count, prize_amount, total_amount
  from lottery_prize_level
  where draw_id = any($1::bigint[])
  order by sort_no
`

async function resolveGame(config, gameNo) {
  const { rows } = await query(
    config,
    'select game_no, game_key, name from lottery_game where game_no = $1 or game_key = $1 limit 1',
    [gameNo],
  )

  if (rows.length === 0) {
    throw new HttpError(404, `未知彩种：${gameNo}（请先执行 npm run db:seed）`)
  }

  return rows[0]
}

export async function getHistoryPage(config, { gameNo, pageNo, pageSize }) {
  const cacheKey = `${gameNo}|${pageNo}|${pageSize}`
  const cached = cache.get(cacheKey)
  if (cached) {
    return { ...cached, cache: 'hit' }
  }

  const game = await resolveGame(config, gameNo)
  const offset = (pageNo - 1) * pageSize
  const { rows } = await query(config, DRAW_SQL, [game.game_no, pageSize, offset])

  const drawIds = rows.map((row) => row.id)
  const levels =
    drawIds.length > 0 ? (await query(config, LEVEL_SQL, [drawIds])).rows : []

  const payload = toHistoryEnvelope({
    draws: rows,
    levels,
    pageNo,
    pageSize,
    total: rows[0]?.total ?? 0,
    gameName: game.name,
  })

  const result = { payload, count: rows.length }
  cache.set(cacheKey, result)
  return { ...result, cache: 'miss' }
}
