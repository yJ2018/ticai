'use client'

import { useSyncExternalStore } from 'react'

/**
 * 路由间传参（替代 react-router 的 `location.state`）。
 *
 * Next App Router 没有 history state，而项目里有三处依赖它：
 *   - 我的投注 → 首页「带着这一单去投注」；
 *   - 列表 → 对战详情「先拿列表里的队名占位」；
 *   - 未登录 → 登录页「登录后回哪」。
 *
 * 这里用一次性内存槽：读完就清空，刷新即丢——和原来 SPA 里跳一次就失效的语义一致。
 */

let current: unknown = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) {
    listener()
  }
}

export function setNavigationState(value: unknown) {
  current = value ?? null
  emit()
}

/** 读一次就清空（跳转后只消费一次的场景） */
export function takeNavigationState<T>(): T | null {
  const value = current as T | null
  if (current !== null) {
    current = null
    emit()
  }
  return value
}

/** 只读不消费（首帧占位用，之后由真实数据覆盖） */
export function readNavigationState<T>(): T | null {
  return current as T | null
}

export function clearNavigationState() {
  if (current !== null) {
    current = null
    emit()
  }
}

export function useNavigationState<T>(): T | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => current as T | null,
    () => null,
  )
}
