import pg from 'pg'

/** 连接池 + 事务 + crawl_run 记账。 */

const { Pool } = pg

export function createPool(database) {
  const pool = new Pool({
    connectionString: database.url,
    ssl: database.ssl,
    max: database.poolMax,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // 单条语句上限：跨境写库时 49 场批量 upsert 能到 90s 以上，60s 会直接撞线
    statement_timeout: database.statementTimeoutMs ?? 180_000,
  })

  // 长跑进程会空闲很久，数据库/中间层可能单方面断开连接。
  // pool 上的 'error' 事件没有监听器时，Node 会直接退出进程（exit code 1 且不一定有栈）——
  // 这里吞掉并交给下一次查询自动重连。
  pool.on('error', (error) => {
    console.error('[db] 空闲连接异常（已忽略，下次查询会重连）：', error.message)
  })

  return pool
}

/**
 * 给「借出中」的连接挂一个 error 监听器。
 *
 * 只监听 pool 不够：借出的 Client 一旦被上游单方面断开（ECONNRESET），pg 会在它身上
 * emit('error')；此时没有监听器，Node 就按未捕获异常退出整个进程。
 * 2026-11-03 的常驻爬虫正是这么挂的：matches 写到一半 write ECONNRESET，
 * 进程直接消失，之后一天没人写库，前端所有数据停更。
 *
 * 监听器只记日志：真正的失败仍由本次 query 的 reject 返回给调用方。
 * 每个 Client 只挂一次（Client 会被 pool 复用，重复挂会堆到 MaxListeners）。
 */
const guardedClients = new WeakSet()

function guardClient(client) {
  if (guardedClients.has(client)) {
    return
  }
  guardedClients.add(client)
  client.on('error', (error) => {
    console.error('[db] 借出连接异常（已交给本次查询处理）：', error.message)
  })
}

export async function withTransaction(pool, fn) {
  const client = await pool.connect()
  guardClient(client)

  let broken = null
  try {
    await client.query('begin')
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (error) {
    // 回滚都失败说明连接已经断了，别把死连接还回池里
    const rolledBack = await client.query('rollback').then(
      () => true,
      () => false,
    )
    if (!rolledBack) {
      broken = error
    }
    throw error
  } finally {
    client.release(broken ?? undefined)
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

/**
 * 启动时收尾上一轮「跑到一半进程没了」的记账。
 *
 * 崩溃/断电时 finishRun 不会执行，库里会留一条永远 running 的记录，
 * 排障和新鲜度判断都会被它带偏；10 分钟窗口避免误伤同时还在跑的另一实例。
 */
export async function failOrphanRuns(pool) {
  const { rowCount } = await pool.query(
    `update crawl_run
     set status = 'failed',
         finished_at = now(),
         error = coalesce(error, '进程中断，未收尾')
     where status = 'running' and started_at < now() - interval '10 minutes'`,
  )
  return rowCount ?? 0
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
