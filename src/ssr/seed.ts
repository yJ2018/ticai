'use client'

import type { SsrInitialData } from '../lib/initial-data'
import { useMatchStore } from '../store/matchStore'

/**
 * 把服务端预取的数据灌进 store，让「切玩法再切回来」「手动刷新」这些交互
 * 走的是同一份缓存，不再重复请求。
 *
 * 只在客户端第一次挂载时灌一次：
 * - 服务端灌了也没用（`useSyncExternalStore` 读的是 initial state）；
 * - 后续软导航重复灌会让用户刚刷新的数据被首屏快照覆盖。
 */

let seeded = false

export function seedInitialData(data: SsrInitialData | null): void {
  if (seeded || typeof window === 'undefined' || !data?.matches) {
    return
  }

  seeded = true
  useMatchStore.getState().hydratePool(data.matches.pool, data.matches.cards, data.matches.dataAsOf)
}
