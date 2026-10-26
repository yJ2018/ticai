import { query } from '../db.mjs'
import { HttpError, createTtlCache } from '../lib.mjs'
import { toHistoryEnvelope } from '../reshape.mjs'

/**
 * 开奖历史：库 → 体彩分页信封。
 *
 * 分页仍用 offset：前端每页 30 条、最多翻到第 78 页，这个量级 offset 无感。
 * 将来要"无限滚动"再换 keyset（issue_seq 游标）。
 *
 * 性能要点（远端 Prisma Postgres 的每次往返约 0.4–1s）：
 * - 一次查询同时取开奖和奖级，避免 draws → levels 两次串行往返；
 * - 彩种元数据进程内缓存，省掉每次请求的 resolveGame 往返；
 * - 历史缓存仍保留 60s，避免「刷新」拿到过旧数据；miss 时靠连接复用把耗时压到 ~1s。
 */

const HISTORY_CACHE_TTL_MS = 60_000
const cache = createTtlCache({ ttlMs: HISTORY_CACHE_TTL_MS, maxEntries: 200 })
const gameCache = new Map()

const DRAW_SQL = `
  select
    d.id,
    d.issue,
    to_char(d.draw_date, 'YYYY-MM-DD') as draw_date,
    d.numbers_text,
    d.sales_amount,
    d.pool_balance,
    count(*) over () as total,
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'prize_key', l.prize_key,
          'sort_no', l.sort_no,
          'stake_count', l.stake_count::text,
          'prize_amount', l.prize_amount::text,
          'total_amount', l.total_amount::text
        )
        order by l.sort_no
      )
      from lottery_prize_level l
      where l.draw_id = d.id
    ), '[]'::jsonb) as levels
  from lottery_draw d
  where d.game_no = $1
  order by d.issue_seq desc
  limit $2 offset $3
`

async function resolveGame(config, gameNo) {
  const cached = gameCache.get(gameNo)
  if (cached) {
    return cached
  }

  const { rows } = await query(
    config,
    'select game_no, game_key, name from lottery_game where game_no = $1 or game_key = $1 limit 1',
    [gameNo],
  )

  if (rows.length === 0) {
    throw new HttpError(404, `未知彩种：${gameNo}（请先执行 npm run db:seed）`)
  }

  const game = rows[0]
  gameCache.set(game.game_no, game)
  gameCache.set(game.game_key, game)
  return game
}

/**
 * 启动时预热：顺带把彩种元数据装进进程缓存。
 * 远端库一次建连 + 一次查询，之后的第一个历史请求就不必再 resolveGame 往返。
 */
export async function warmGameCache(config) {
  const { rows } = await query(config, 'select game_no, game_key, name from lottery_game')
  for (const row of rows) {
    gameCache.set(row.game_no, row)
    gameCache.set(row.game_key, row)
  }
  return rows.length
}

export async function getHistoryPage(config, { gameNo, pageNo, pageSize }) {
  const cacheKey = `${gameNo}|${pageNo}|${pageSize}`
  const cached = cache.get(cacheKey)
  if (cached) {
    return {
      ...cached,
      cache: 'hit',
      // 命中时没有 DB/reshape 耗时，Server-Timing 里体现为 0
      timings: { resolve: 0, query: 0, reshape: 0, total: 0 },
    }
  }

  const startedAt = performance.now()
  const resolveStartedAt = performance.now()
  const game = await resolveGame(config, gameNo)
  const resolveMs = performance.now() - resolveStartedAt
  const queryStartedAt = performance.now()
  const offset = (pageNo - 1) * pageSize
  const { rows } = await query(config, DRAW_SQL, [game.game_no, pageSize, offset])
  const queryMs = performance.now() - queryStartedAt
  const reshapeStartedAt = performance.now()

  // 把嵌套的奖级 JSON 摊平成 reshape 需要的行结构
  const levels = []
  for (const row of rows) {
    for (const level of row.levels ?? []) {
      levels.push({
        draw_id: row.id,
        prize_key: level.prize_key,
        sort_no: level.sort_no,
        stake_count: level.stake_count,
        prize_amount: level.prize_amount,
        total_amount: level.total_amount,
      })
    }
  }

  const payload = toHistoryEnvelope({
    draws: rows,
    levels,
    pageNo,
    pageSize,
    total: rows[0]?.total ?? 0,
    gameName: game.name,
  })
  const reshapeMs = performance.now() - reshapeStartedAt
  const totalMs = performance.now() - startedAt

  if (totalMs >= 300) {
    console.log(
      `[history] ${gameNo} p${pageNo}/${pageSize} ${totalMs.toFixed(0)}ms ` +
        `resolve=${resolveMs.toFixed(0)} query=${queryMs.toFixed(0)} ` +
        `reshape=${reshapeMs.toFixed(0)} rows=${rows.length} cache=miss`,
    )
  }

  const result = {
    payload,
    count: rows.length,
    timings: {
      resolve: resolveMs,
      query: queryMs,
      reshape: reshapeMs,
      total: totalMs,
    },
  }
  cache.set(cacheKey, result)
  return { ...result, cache: 'miss' }
}
