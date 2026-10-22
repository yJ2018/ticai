import pg from 'pg'

/** 连接池 + 事务 + crawl_run 记账。 */

const { Pool } = pg

export function createPool(database) {
  return new Pool({
    connectionString: database.url,
    ssl: database.ssl,
    max: database.poolMax,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // 单条语句上限：回灌大页时给足，但不至于无限挂着
    statement_timeout: 60_000,
  })
}

export async function withTransaction(pool, fn) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** 开一条抓取记录；失败也要落库，否则新鲜度判断会误以为从没跑过。 */
export async function startRun(pool, { source, meta = {} }) {
  const { rows } = await pool.query(
    `insert into crawl_run (source, status, meta) values ($1, 'running', $2) returning id`,
    [source, meta],
  )
  return rows[0].id
}

export async function finishRun(pool, id, { status, httpStatus = null, itemCount = 0, changedCount = 0, error = null }) {
  await pool.query(
    `update crawl_run set
       status = $2,
       finished_at = now(),
       duration_ms = coalesce(extract(epoch from (now() - started_at)) * 1000, 0)::int,
       http_status = $3,
       item_count = $4,
       changed_count = $5,
       error = $6
     where id = $1`,
    [id, status, httpStatus, itemCount, changedCount, error],
  ).catch((dbError) => {
    console.error('[crawler] 写入 crawl_run 失败：', dbError.message)
  })
}

/** 从字典表读彩种结构，爬虫不硬编码号码位数。 */
export async function loadGames(pool, keys) {
  const { rows } = await pool.query(
    `select game_no, game_key, name, main_count, extra_count
     from lottery_game
     where active and game_no = any($1::text[])
     order by game_key`,
    [keys],
  )
  return rows.map((row) => ({
    gameNo: row.game_no,
    gameKey: row.game_key,
    name: row.name,
    mainCount: row.main_count,
    extraCount: row.extra_count,
  }))
}
