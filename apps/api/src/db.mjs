import { HttpError } from './lib.mjs'

/**
 * PostgreSQL 访问层（只有 pg 一个依赖，且延迟加载）。
 *
 * 延迟 import 的好处：没有装 pg、或者没有配 DATABASE_URL 时，
 * 进程依然能启动，只有真正访问数据库的接口返回 503 —— 本地联调和不含库的
 * 健康检查都不会被拖死。
 */

const state = (globalThis.__ticaiDb ??= { pool: null, pending: null })

export async function getPool(config) {
  if (state.pool) {
    return state.pool
  }

  if (!config.database.url) {
    throw new HttpError(503, '服务端未配置 DATABASE_URL')
  }

  if (!state.pending) {
    state.pending = (async () => {
      let Pg
      try {
        Pg = (await import('pg')).default
      } catch {
        throw new HttpError(503, '缺少依赖 pg，请先执行 npm install')
      }

      const pool = new Pg.Pool({
        connectionString: config.database.url,
        ssl: config.database.ssl,
        max: config.database.poolMax,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 8_000,
        // 单条查询上限，避免慢查询把实例拖住
        statement_timeout: 10_000,
      })

      // 空闲连接报错不应让进程崩溃（数据库重启/网络抖动是常态）
      pool.on('error', (error) => {
        console.error('[db] 空闲连接异常：', error.message)
      })

      return pool
    })()
  }

  try {
    state.pool = await state.pending
    return state.pool
  } catch (error) {
    // 失败不缓存，下次请求可以重试
    state.pending = null
    throw error
  }
}

export async function query(config, text, params = []) {
  const pool = await getPool(config)
  return pool.query(text, params)
}

/** 健康检查用：连不上就返回 false，不抛错。 */
export async function ping(config) {
  try {
    const pool = await getPool(config)
    await pool.query('select 1')
    return true
  } catch {
    return false
  }
}

/** Vercel 冷启动/热实例复用，进程退出前显式释放连接。 */
export async function closePool() {
  if (state.pool) {
    const pool = state.pool
    state.pool = null
    state.pending = null
    await pool.end().catch(() => {})
  }
}
