import { getMatchResults } from '../api/resultsApi'
import type { SsrInitialData } from '../lib/initial-data'
import { matchAppRoute } from '../router/manifest'
import { matchService } from '../service/matchService'

/**
 * 服务端首屏取数。
 *
 * 运行在 Node（Server Component）里，走 `SSR_API_ORIGIN` 的绝对地址；
 * 与浏览器同源 `/api` 完全是同一套接口，只是没有「同源」可言。
 *
 * 约定：**永不抛错**。取数失败就返回 null，页面退回「客户端自己拉」，
 * 宁可首屏少内容，也不要 SSR 500 或让请求卡住。
 */

/** 首屏取数预算：超过就放弃，交给客户端 */
const PREFETCH_TIMEOUT_MS = 2500

export async function loadInitialData(pathname: string): Promise<SsrInitialData | null> {
  if (!matchAppRoute(pathname)) {
    return null
  }

  // 目前只给「首屏就是数据」的两个页面预取；
  // results 按期翻页在客户端做，服务端取最近一期即可（不传 period）。
  if (pathname === '/') {
    return prefetchHome(pathname)
  }

  if (pathname === '/results') {
    return prefetchResults(pathname)
  }

  return null
}

async function prefetchResults(pathname: string): Promise<SsrInitialData | null> {
  try {
    // 不传期：后端按「最近一期（销售日）」返回，比按自然日取今早更准
    const data = await withTimeout(getMatchResults({ limit: 500 }), PREFETCH_TIMEOUT_MS)
    return {
      path: pathname,
      results: {
        period: data.period,
        label: data.label,
        periods: data.periods,
        items: data.items,
        updatedAt: data.updatedAt,
      },
    }
  } catch (error) {
    console.warn('[ssr] 赛果预取失败，退回客户端加载：', error instanceof Error ? error.message : error)
    return null
  }
}

async function prefetchHome(pathname: string): Promise<SsrInitialData | null> {
  try {
    // 首页默认玩法是 ttg（见 matchStore 初始状态），预取同一个池子才不会白跑一次
    const result = await withTimeout(matchService.getMatchCards('ttg'), PREFETCH_TIMEOUT_MS)
    return { path: pathname, matches: { pool: 'ttg', cards: result.cards, dataAsOf: result.dataAsOf } }
  } catch (error) {
    console.warn('[ssr] 首页预取失败，退回客户端加载：', error instanceof Error ? error.message : error)
    return null
  }
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`预取超时（${timeoutMs}ms）`)), timeoutMs)
    task.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
