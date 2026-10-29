'use client'

import { createContext, useContext, type ReactNode } from 'react'

import type { InitialMatches, InitialResults, SsrInitialData } from '../lib/initial-data'

/**
 * 首屏数据通道。
 *
 * 为什么不用 zustand store 传：`useSyncExternalStore` 在服务端与 hydration 首帧
 * 用的是 **zustand 的 initial state**（`getInitialState`），往 store 里 setState
 * 不会出现在 SSR 输出里。React context 是 props 级别的通道，两端都能读到。
 *
 * 服务端渲染、hydration 首帧都从这里取数；客户端挂载后再把同一份数据灌进 store，
 * 之后的刷新、切换玩法仍走原来的 store 逻辑。
 */

const InitialDataContext = createContext<SsrInitialData | null>(null)

export function InitialDataProvider({
  value,
  children,
}: {
  value: SsrInitialData | null
  children: ReactNode
}) {
  return <InitialDataContext.Provider value={value}>{children}</InitialDataContext.Provider>
}

/** 服务端预取的比赛列表（没有就是 null，页面自己拉） */
export function useInitialMatches(): InitialMatches | null {
  return useContext(InitialDataContext)?.matches ?? null
}

/** 服务端预取的赛果开奖（没有就是 null，页面自己拉） */
export function useInitialResults(): InitialResults | null {
  return useContext(InitialDataContext)?.results ?? null
}
