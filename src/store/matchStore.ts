import { create } from 'zustand'
import { matchService, type MatchCard, type MatchPoolType } from '../service/matchService'

type MatchState = {
  activePool: MatchPoolType
  keyword: string
  poolCache: Record<MatchPoolType, PoolCacheItem>
  extraCardsByPool: Record<MatchPoolType, MatchCard[]>
  setActivePool: (pool: MatchPoolType) => void
  setKeyword: (keyword: string) => void
  loadMatches: (pool?: MatchPoolType, force?: boolean) => Promise<void>
  addMockCard: () => void
}

type PoolCacheItem = {
  loading: boolean
  error: string
  cards: MatchCard[]
  fetched: boolean
}

const POOLS: MatchPoolType[] = ['had', 'crs', 'ttg', 'hafu', 'mixed']

function createEmptyPoolCacheItem(): PoolCacheItem {
  return {
    loading: false,
    error: '',
    cards: [],
    fetched: false,
  }
}

function createInitialPoolCache() {
  return POOLS.reduce<Record<MatchPoolType, PoolCacheItem>>((acc, pool) => {
    acc[pool] = createEmptyPoolCacheItem()
    return acc
  }, {} as Record<MatchPoolType, PoolCacheItem>)
}

function createInitialExtraCardsByPool() {
  return POOLS.reduce<Record<MatchPoolType, MatchCard[]>>((acc, pool) => {
    acc[pool] = []
    return acc
  }, {} as Record<MatchPoolType, MatchCard[]>)
}

export const useMatchStore = create<MatchState>((set, get) => ({
  activePool: 'ttg',
  keyword: '',
  poolCache: createInitialPoolCache(),
  extraCardsByPool: createInitialExtraCardsByPool(),

  setActivePool: (pool) => {
    set({ activePool: pool })
    const cache = get().poolCache[pool]
    if (!cache.fetched && !cache.loading) {
      void get().loadMatches(pool)
    }
  },

  setKeyword: (keyword) => set({ keyword }),

  loadMatches: async (pool = get().activePool, force = false) => {
    const current = get().poolCache[pool]
    if (!force && (current.loading || current.fetched)) {
      return
    }

    set((state) => ({
      poolCache: {
        ...state.poolCache,
        [pool]: {
          ...state.poolCache[pool],
          loading: true,
          error: '',
        },
      },
    }))

    try {
      const cards = await matchService.getMatchCards(pool)
      set((state) => ({
        poolCache: {
          ...state.poolCache,
          [pool]: {
            loading: false,
            error: '',
            cards,
            fetched: true,
          },
        },
      }))
    } catch {
      set((state) => ({
        poolCache: {
          ...state.poolCache,
          [pool]: {
            loading: false,
            error: '比赛数据加载失败，请稍后重试',
            cards: [],
            fetched: false,
          },
        },
      }))
    }
  },

  addMockCard: () => {
    const now = new Date().toLocaleString()
    const pool = get().activePool
    const index = get().extraCardsByPool[pool].length + 1
    const mock: MatchCard = {
      id: Date.now(),
      title: `手动新增赛事 ${index}`,
      subtitle: '自定义',
      time: now,
      oddsSummary: '自定义赔率',
    }

    set((state) => ({
      extraCardsByPool: {
        ...state.extraCardsByPool,
        [pool]: [mock, ...state.extraCardsByPool[pool]],
      },
    }))
  },
}))
