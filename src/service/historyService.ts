import { getLotteryHistoryPage } from '../api'
import {
  type LotteryHistoryCache,
  type LotteryHistoryEntry,
  type LotteryHistoryGameType,
  type LotteryHistoryPageResult,
} from '../domain/lotteryHistory'
import { pruneHistoryCache, readHistoryCache, writeHistoryCache } from '../storage/historyDb'
import { type LotteryHistoryItem, type LotteryPrizeLevelItem } from '../domain/sporttery'

export type { LotteryHistoryEntry, LotteryHistoryGameType, LotteryHistoryPageResult }

const HISTORY_GAME_CONFIG: Record<LotteryHistoryGameType, { gameNo: string; label: string }> = {
  pl5: {
    gameNo: '350133',
    label: '排列五',
  },
  qxc: {
    gameNo: '04',
    label: '七星彩',
  },
  dlt: {
    gameNo: '85',
    label: '大乐透',
  },
}

/** 上一版用的是 localStorage，这里保留 key 仅用于一次性迁移 */
const HISTORY_LEGACY_STORAGE_KEY = 'ticai:history-cache:v1'
const HISTORY_CACHE_VERSION = 2
const HISTORY_ARCHIVE_PAGE_SIZE = 100
const HISTORY_INCREMENTAL_SYNC_INTERVAL_MS = 10 * 60 * 1000
/** IndexedDB 内的条目上限：超出后按开奖期号裁剪最旧记录 */
const HISTORY_MAX_STORED_ENTRIES = 20_000

/** 当前进程内的权威缓存；IndexedDB 只负责持久化 */
const cacheByGame = new Map<LotteryHistoryGameType, LotteryHistoryCache>()
const loadPromises = new Map<LotteryHistoryGameType, Promise<LotteryHistoryCache | null>>()
const archivePageRequestPromises = new Map<string, Promise<LotteryHistoryPageResult>>()
const incrementalSyncPromises = new Map<LotteryHistoryGameType, Promise<LotteryHistoryCache | null>>()

export const historyService = {
  async getHistoryPage(
    gameType: LotteryHistoryGameType,
    pageNo = 1,
    pageSize = 30,
  ): Promise<LotteryHistoryPageResult> {
    const requiredCount = pageNo * pageSize
    let cache = await loadCache(gameType)

    if (!cache) {
      cache = await ensureArchiveCoverage(gameType, requiredCount)
    } else {
      if (pageNo === 1) {
        try {
          cache = (await syncIncrementalHistory(gameType)) ?? cache
        } catch {
          // 网络不可用时继续使用本地缓存，保证离线仍能查看历史
        }
      } else if (shouldRunIncrementalSync(cache)) {
        void syncIncrementalHistory(gameType).catch(() => {
          // 后台增量同步失败不影响本次渲染
        })
      }

      if (!hasCoverageForRange(cache, requiredCount)) {
        cache = await ensureArchiveCoverage(gameType, requiredCount)
      }
    }

    if (!cache) {
      return {
        list: [],
        pageNo,
        pageSize,
        total: 0,
        pages: 1,
      }
    }

    return buildPageResult(cache, pageNo, pageSize)
  },
}

function getMemoryCache(gameType: LotteryHistoryGameType) {
  return cacheByGame.get(gameType)
}

/**
 * 读取缓存：内存 → IndexedDB → 旧 localStorage 迁移。
 * 同一彩种并发调用只会触发一次加载。
 */
async function loadCache(gameType: LotteryHistoryGameType): Promise<LotteryHistoryCache | null> {
  const cached = cacheByGame.get(gameType)
  if (cached) {
    return cached
  }

  const pending = loadPromises.get(gameType)
  if (pending) {
    return pending
  }

  const promise = (async () => {
    const stored = await readHistoryCache(gameType)
    if (stored) {
      const cache: LotteryHistoryCache = {
        ...stored.meta,
        items: dedupeHistoryEntries(stored.entries),
      }
      cacheByGame.set(gameType, cache)
      return cache
    }

    return migrateLegacyCache(gameType)
  })().finally(() => {
    loadPromises.delete(gameType)
  })

  loadPromises.set(gameType, promise)
  return promise
}

type LegacyHistoryCache = Partial<LotteryHistoryCache> & { version?: number }

/** 首次升级时把 localStorage 中的旧缓存导入 IndexedDB，导入成功后删除旧 key */
async function migrateLegacyCache(gameType: LotteryHistoryGameType): Promise<LotteryHistoryCache | null> {
  if (typeof window === 'undefined') {
    return null
  }

  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(HISTORY_LEGACY_STORAGE_KEY)
  } catch {
    return null
  }

  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as Partial<Record<LotteryHistoryGameType, LegacyHistoryCache>> | null
    const legacy = parsed?.[gameType]
    if (!legacy || !Array.isArray(legacy.items)) {
      return null
    }

    const items = dedupeHistoryEntries(
      legacy.items.filter((item): item is LotteryHistoryEntry => Boolean(item && item.issue)),
    )
    if (items.length === 0) {
      return null
    }

    const now = Date.now()
    const cache: LotteryHistoryCache = {
      version: HISTORY_CACHE_VERSION,
      gameType,
      items: items.slice(0, HISTORY_MAX_STORED_ENTRIES),
      total: Math.max(Number(legacy.total) || 0, items.length),
      archivePageSize: Number(legacy.archivePageSize) || HISTORY_ARCHIVE_PAGE_SIZE,
      archivePages: Math.max(Number(legacy.archivePages) || 1, 1),
      loadedArchivePages: sortUniqueNumbers(
        Array.isArray(legacy.loadedArchivePages) ? legacy.loadedArchivePages : [],
      ),
      fullySynced: Boolean(legacy.fullySynced),
      newestIssue: legacy.newestIssue || items[0].issue,
      lastUpdatedAt: Number(legacy.lastUpdatedAt) || now,
      lastIncrementalSyncAt: Number(legacy.lastIncrementalSyncAt) || 0,
    }

    cacheByGame.set(gameType, cache)
    const written = await writeHistoryCache(cache, cache.items)
    if (written) {
      try {
        window.localStorage.removeItem(HISTORY_LEGACY_STORAGE_KEY)
        console.info(`[history] 已迁移 ${cache.items.length} 条开奖缓存：localStorage → IndexedDB`)
      } catch {
        // 删除旧 key 失败不影响使用
      }
    }

    return cache
  } catch {
    return null
  }
}

/** 写入持久层并做容量裁剪（内存与磁盘保持一致） */
async function persistCache(cache: LotteryHistoryCache, addedEntries: LotteryHistoryEntry[]) {
  const written = await writeHistoryCache(cache, addedEntries)
  if (!written) {
    return cache
  }

  const removed = await pruneHistoryCache(cache.gameType, HISTORY_MAX_STORED_ENTRIES)
  if (removed > 0) {
    cache.items = cache.items.slice(0, HISTORY_MAX_STORED_ENTRIES)
    console.info(`[history] 缓存超过 ${HISTORY_MAX_STORED_ENTRIES} 条，已裁剪最旧 ${removed} 条`)
  }

  return cache
}

async function ensureArchiveCoverage(gameType: LotteryHistoryGameType, requiredCount: number) {
  let cache = await loadCache(gameType)

  if (!cache) {
    cache = await mergeArchivePageIntoCache(gameType, 1)
  }

  const requiredArchivePage = Math.max(1, Math.ceil(requiredCount / HISTORY_ARCHIVE_PAGE_SIZE))
  for (let archivePageNo = 1; archivePageNo <= requiredArchivePage; archivePageNo += 1) {
    if (cache.loadedArchivePages.includes(archivePageNo)) {
      continue
    }
    cache = await mergeArchivePageIntoCache(gameType, archivePageNo)
  }

  return cache
}

function buildPageResult(
  cache: LotteryHistoryCache,
  pageNo: number,
  pageSize: number,
): LotteryHistoryPageResult {
  const normalizedPageNo = Math.max(1, Math.floor(pageNo))
  const normalizedPageSize = Math.max(1, Math.floor(pageSize))
  const dedupedItems = dedupeHistoryEntries(cache.items)
  const start = (normalizedPageNo - 1) * normalizedPageSize
  const end = start + normalizedPageSize

  return {
    list: dedupedItems.slice(start, end),
    pageNo: normalizedPageNo,
    pageSize: normalizedPageSize,
    total: Math.max(cache.total, dedupedItems.length),
    pages: Math.max(1, Math.ceil(Math.max(cache.total, dedupedItems.length) / normalizedPageSize)),
  }
}

function hasCoverageForRange(cache: LotteryHistoryCache, requiredCount: number) {
  if (requiredCount <= 0) {
    return true
  }

  const targetCount = Math.min(requiredCount, cache.total || requiredCount)
  return cache.items.length >= targetCount || cache.fullySynced
}

function shouldRunIncrementalSync(cache: LotteryHistoryCache) {
  if (cache.lastIncrementalSyncAt <= 0) {
    return true
  }
  return Date.now() - cache.lastIncrementalSyncAt >= HISTORY_INCREMENTAL_SYNC_INTERVAL_MS
}

async function syncIncrementalHistory(gameType: LotteryHistoryGameType) {
  const existingPromise = incrementalSyncPromises.get(gameType)
  if (existingPromise) {
    return existingPromise
  }

  const promise = (async () => {
    const cache = await loadCache(gameType)
    const latestIssue = cache?.newestIssue ?? ''
    let pageNo = 1
    let mergedCache: LotteryHistoryCache | null = cache ?? null
    let shouldContinue = true

    while (shouldContinue) {
      const result = await fetchArchivePage(gameType, pageNo)
      mergedCache = await mergeCacheIntoStorage(gameType, result, { markIncrementalSync: true })

      if (!latestIssue) {
        break
      }

      const foundExistingLatest = result.list.some((item) => item.issue === latestIssue)
      pageNo += 1
      shouldContinue = !foundExistingLatest && pageNo <= result.pages
    }

    return mergedCache
  })().finally(() => {
    incrementalSyncPromises.delete(gameType)
  })

  incrementalSyncPromises.set(gameType, promise)
  return promise
}

async function mergeArchivePageIntoCache(gameType: LotteryHistoryGameType, archivePageNo: number) {
  const result = await fetchArchivePage(gameType, archivePageNo)
  return mergeCacheIntoStorage(gameType, result)
}

async function mergeCacheIntoStorage(
  gameType: LotteryHistoryGameType,
  result: LotteryHistoryPageResult,
  options: { markIncrementalSync?: boolean } = {},
) {
  const current = getMemoryCache(gameType) ?? (await loadCache(gameType))
  const knownIssues = new Set(current?.items.map((item) => item.issue) ?? [])
  const next = mergeHistoryCache(gameType, current, result, options)
  const addedEntries = next.items.filter((item) => !knownIssues.has(item.issue))

  cacheByGame.set(gameType, next)
  return persistCache(next, addedEntries)
}

function mergeHistoryCache(
  gameType: LotteryHistoryGameType,
  cache: LotteryHistoryCache | null,
  result: LotteryHistoryPageResult,
  options: { markIncrementalSync?: boolean } = {},
): LotteryHistoryCache {
  const loadedArchivePages = sortUniqueNumbers([...(cache?.loadedArchivePages ?? []), result.pageNo])
  const mergedItems = mergeHistoryEntries(cache?.items ?? [], result.list)
  const nextArchivePages = Math.max(result.pages, cache?.archivePages ?? 1)
  const nextTotal = Math.max(result.total, cache?.total ?? 0, mergedItems.length)
  const fullySynced = loadedArchivePages.length >= nextArchivePages
  const now = Date.now()

  return {
    version: HISTORY_CACHE_VERSION,
    gameType: cache?.gameType ?? gameType,
    items: mergedItems,
    total: nextTotal,
    archivePageSize: result.pageSize,
    archivePages: nextArchivePages,
    loadedArchivePages,
    fullySynced,
    newestIssue: mergedItems[0]?.issue ?? cache?.newestIssue ?? '',
    lastUpdatedAt: now,
    lastIncrementalSyncAt: options.markIncrementalSync ? now : (cache?.lastIncrementalSyncAt ?? 0),
  }
}

async function fetchArchivePage(
  gameType: LotteryHistoryGameType,
  pageNo: number,
): Promise<LotteryHistoryPageResult> {
  const requestKey = `${gameType}:${pageNo}`
  const existingPromise = archivePageRequestPromises.get(requestKey)
  if (existingPromise) {
    return existingPromise
  }

  const promise = requestArchivePage(gameType, pageNo).finally(() => {
    archivePageRequestPromises.delete(requestKey)
  })

  archivePageRequestPromises.set(requestKey, promise)
  return promise
}

async function requestArchivePage(
  gameType: LotteryHistoryGameType,
  pageNo: number,
): Promise<LotteryHistoryPageResult> {
  const config = HISTORY_GAME_CONFIG[gameType]
  const data = await getLotteryHistoryPage({
    gameNo: config.gameNo,
    pageNo,
    pageSize: HISTORY_ARCHIVE_PAGE_SIZE,
    provinceId: 0,
    isVerify: 1,
    termLimits: 0,
  })

  const list = Array.isArray(data.list) ? data.list.map(toHistoryEntry) : []
  return {
    list,
    pageNo: toSafeInteger(data.pageNo, pageNo),
    pageSize: toSafeInteger(data.pageSize, HISTORY_ARCHIVE_PAGE_SIZE),
    total: toSafeInteger(data.total, list.length),
    pages: toSafeInteger(data.pages, 1),
  }
}

function mergeHistoryEntries(currentItems: LotteryHistoryEntry[], incomingItems: LotteryHistoryEntry[]) {
  const mergedByIssue = new Map<string, LotteryHistoryEntry>()

  for (const item of currentItems) {
    mergedByIssue.set(item.issue, item)
  }

  for (const item of incomingItems) {
    mergedByIssue.set(item.issue, item)
  }

  return Array.from(mergedByIssue.values()).sort(compareHistoryEntries)
}

function compareHistoryEntries(a: LotteryHistoryEntry, b: LotteryHistoryEntry) {
  return compareIssueDescending(a.issue, b.issue)
}

function compareIssueDescending(leftIssue: string, rightIssue: string) {
  const left = Number(leftIssue)
  const right = Number(rightIssue)

  if (Number.isFinite(left) && Number.isFinite(right)) {
    return right - left
  }

  return String(rightIssue).localeCompare(String(leftIssue), 'zh-CN')
}

function sortUniqueNumbers(values: number[]) {
  return Array.from(new Set(values)).sort((left, right) => left - right)
}

function toHistoryEntry(item: LotteryHistoryItem): LotteryHistoryEntry {
  const firstPrize = getFirstPrize(item.prizeLevelList)

  return {
    issue: item.lotteryDrawNum || '--',
    drawDate: formatDrawDate(item.lotteryDrawTime || item.lotterySaleEndtime || ''),
    numbers: splitDrawNumbers(item.lotteryDrawResult || item.lotteryUnsortDrawresult || ''),
    salesAmount: formatAmount(item.lotterySaleAmount),
    poolAmount: formatAmount(item.poolAmount),
    firstPrizeCount: formatCount(firstPrize?.stakeCount),
    firstPrizeAmount: formatAmount(firstPrize?.prizeAmount ?? firstPrize?.totalAmount),
  }
}

function dedupeHistoryEntries(items: LotteryHistoryEntry[]) {
  return Array.from(new Map(items.map((item) => [item.issue, item])).values()).sort(compareHistoryEntries)
}

function getFirstPrize(prizeLevelList: LotteryPrizeLevelItem[] | undefined) {
  if (!Array.isArray(prizeLevelList) || prizeLevelList.length === 0) {
    return undefined
  }

  return (
    prizeLevelList.find((item) => String(item.prizeLevel ?? '').includes('1')) ??
    prizeLevelList.find((item) => String(item.prizeLevelName ?? '').includes('一')) ??
    prizeLevelList[0]
  )
}

function splitDrawNumbers(value: string) {
  const normalized = value.trim()
  if (!normalized) {
    return ['--', '--', '--', '--', '--']
  }

  const tokens = normalized.includes(' ') ? normalized.split(/\s+/) : normalized.split('')
  return tokens.filter(Boolean)
}

function formatDrawDate(value: string) {
  if (!value) {
    return '--'
  }
  return value.split(' ')[0] || value
}

function formatAmount(value: number | string | undefined) {
  if (value === undefined || value === null || value === '') {
    return '--'
  }

  const text = String(value).replace(/,/g, '').trim()
  const numeric = Number(text)
  if (!Number.isFinite(numeric)) {
    return String(value)
  }
  return new Intl.NumberFormat('zh-CN').format(numeric)
}

function formatCount(value: number | string | undefined) {
  if (value === undefined || value === null || value === '') {
    return '--'
  }
  return String(value)
}

function toSafeInteger(value: unknown, fallback: number) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback
}
