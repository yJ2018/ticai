import {
  type LotteryHistoryCache,
  type LotteryHistoryCacheMeta,
  type LotteryHistoryEntry,
  type LotteryHistoryGameType,
} from '../domain/lotteryHistory'

/**
 * 开奖历史持久化层：IndexedDB。
 *
 * 设计取舍：
 * - 与 localStorage 不同，IndexedDB 没有 5MB 硬上限，适合"全量历史"这种只追加数据集。
 * - 元数据与开奖条目分两个 store：同步时只写入新增条目，避免每次都重写整份数组。
 * - `byGameOrder` 复合索引用于按开奖期号（数值）裁剪最旧数据。
 */

const DB_NAME = 'ticai'
const DB_VERSION = 1
const META_STORE = 'history_meta'
const DRAW_STORE = 'history_draws'

type DrawRecord = LotteryHistoryEntry & {
  key: string
  gameType: LotteryHistoryGameType
  issueOrder: number
}

export type StoredHistoryCache = {
  meta: LotteryHistoryCacheMeta
  entries: LotteryHistoryEntry[]
}

let databasePromise: Promise<IDBDatabase | null> | null = null

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) {
    return databasePromise
  }

  databasePromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }

    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'gameType' })
      }
      if (!db.objectStoreNames.contains(DRAW_STORE)) {
        const store = db.createObjectStore(DRAW_STORE, { keyPath: 'key' })
        store.createIndex('byGame', 'gameType', { unique: false })
        store.createIndex('byGameOrder', ['gameType', 'issueOrder'], { unique: false })
      }
    }

    request.onsuccess = () => {
      const db = request.result
      // 其他标签页升级数据库时主动让路，避免阻塞
      db.onversionchange = () => db.close()
      resolve(db)
    }

    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })

  return databasePromise
}

function toIssueOrder(issue: string) {
  const numeric = Number(issue)
  return Number.isFinite(numeric) ? numeric : 0
}

function toRecord(gameType: LotteryHistoryGameType, entry: LotteryHistoryEntry): DrawRecord {
  return {
    ...entry,
    key: `${gameType}:${entry.issue}`,
    gameType,
    issueOrder: toIssueOrder(entry.issue),
  }
}

function toEntry(record: DrawRecord): LotteryHistoryEntry {
  return {
    issue: record.issue,
    drawDate: record.drawDate,
    numbers: Array.isArray(record.numbers) ? record.numbers : [],
    salesAmount: record.salesAmount,
    poolAmount: record.poolAmount,
    firstPrizeCount: record.firstPrizeCount,
    firstPrizeAmount: record.firstPrizeAmount,
  }
}

function compareIssuesDescending(left: LotteryHistoryEntry, right: LotteryHistoryEntry) {
  return toIssueOrder(right.issue) - toIssueOrder(left.issue)
}

/** 读取某彩种的元数据与全部条目；无数据 / 不可用时返回 null */
export async function readHistoryCache(gameType: LotteryHistoryGameType): Promise<StoredHistoryCache | null> {
  const db = await openDatabase()
  if (!db) {
    return null
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (value: StoredHistoryCache | null) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }

    try {
      const tx = db.transaction([META_STORE, DRAW_STORE], 'readonly')
      const metaRequest = tx.objectStore(META_STORE).get(gameType)
      const drawsRequest = tx
        .objectStore(DRAW_STORE)
        .index('byGame')
        .getAll(IDBKeyRange.only(gameType))

      tx.oncomplete = () => {
        const meta = metaRequest.result as LotteryHistoryCacheMeta | undefined
        if (!meta) {
          finish(null)
          return
        }
        const records = (drawsRequest.result ?? []) as DrawRecord[]
        finish({ meta, entries: records.map(toEntry).sort(compareIssuesDescending) })
      }

      tx.onerror = () => finish(null)
      tx.onabort = () => finish(null)
    } catch {
      finish(null)
    }
  })
}

/** 写入元数据 + 增量条目（只写新增，不重写全量） */
export async function writeHistoryCache(
  cache: LotteryHistoryCache,
  entries: LotteryHistoryEntry[],
): Promise<boolean> {
  const db = await openDatabase()
  if (!db) {
    return false
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction([META_STORE, DRAW_STORE], 'readwrite')
      const meta: LotteryHistoryCacheMeta = {
        version: cache.version,
        gameType: cache.gameType,
        total: cache.total,
        archivePageSize: cache.archivePageSize,
        archivePages: cache.archivePages,
        loadedArchivePages: cache.loadedArchivePages,
        fullySynced: cache.fullySynced,
        newestIssue: cache.newestIssue,
        lastUpdatedAt: cache.lastUpdatedAt,
        lastIncrementalSyncAt: cache.lastIncrementalSyncAt,
      }

      tx.objectStore(META_STORE).put(meta)

      const store = tx.objectStore(DRAW_STORE)
      for (const entry of entries) {
        store.put(toRecord(cache.gameType, entry))
      }

      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

function countDraws(db: IDBDatabase, gameType: LotteryHistoryGameType): Promise<number> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(DRAW_STORE, 'readonly')
      const request = tx.objectStore(DRAW_STORE).index('byGame').count(IDBKeyRange.only(gameType))
      tx.oncomplete = () => resolve(Number(request.result) || 0)
      tx.onerror = () => resolve(0)
      tx.onabort = () => resolve(0)
    } catch {
      resolve(0)
    }
  })
}

/** 按开奖期号裁剪最旧记录，返回删除数量 */
export async function pruneHistoryCache(
  gameType: LotteryHistoryGameType,
  maxEntries: number,
): Promise<number> {
  const db = await openDatabase()
  if (!db) {
    return 0
  }

  const total = await countDraws(db, gameType)
  const overflow = total - maxEntries
  if (overflow <= 0) {
    return 0
  }

  return new Promise((resolve) => {
    let removed = 0

    try {
      const tx = db.transaction(DRAW_STORE, 'readwrite')
      const index = tx.objectStore(DRAW_STORE).index('byGameOrder')
      const range = IDBKeyRange.bound(
        [gameType, Number.NEGATIVE_INFINITY],
        [gameType, Number.POSITIVE_INFINITY],
      )
      const request = index.openCursor(range)

      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor || removed >= overflow) {
          return
        }
        cursor.delete()
        removed += 1
        cursor.continue()
      }

      tx.oncomplete = () => resolve(removed)
      tx.onerror = () => resolve(removed)
      tx.onabort = () => resolve(removed)
    } catch {
      resolve(0)
    }
  })
}

/** 清空某彩种缓存（调试 / 重置用） */
export async function clearHistoryCache(gameType: LotteryHistoryGameType): Promise<void> {
  const db = await openDatabase()
  if (!db) {
    return
  }

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction([META_STORE, DRAW_STORE], 'readwrite')
      tx.objectStore(META_STORE).delete(gameType)
      tx.objectStore(DRAW_STORE).delete(IDBKeyRange.bound(`${gameType}:`, `${gameType}:\uffff`))
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

/** IndexedDB 是否可用（隐私模式 / 老旧浏览器可能不可用） */
export async function isHistoryCacheAvailable(): Promise<boolean> {
  return (await openDatabase()) !== null
}
