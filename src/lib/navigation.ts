'use client'

import { usePathname as useNextPathname, useRouter } from 'next/navigation'
import { useCallback } from 'react'

import { setNavigationState } from './nav-state'

/**
 * 导航适配层。
 *
 * 页面里原来用 react-router 的 `useNavigate(to, { replace, state })`，
 * 这里保留同样的调用形状，内部换成 Next 的 router：
 *   - 字符串 + `{ replace }` → router.replace / router.push
 *   - 字符串 + `{ state }`   → 写一次性路由状态（Next 没有 history state）
 *   - 数字（-1）             → router.back()
 */

export type NavigateOptions = {
  replace?: boolean
  state?: unknown
}

export type AppNavigate = (to: string | number, options?: NavigateOptions) => void

export function useNavigate(): AppNavigate {
  const router = useRouter()

  return useCallback<AppNavigate>(
    (to, options) => {
      if (typeof to === 'number') {
        router.back()
        return
      }

      if (options && 'state' in options) {
        setNavigationState(options.state)
      }

      if (options?.replace) {
        router.replace(to)
      } else {
        router.push(to)
      }
    },
    [router],
  )
}

/** 当前路径（不含查询串，末尾不带斜杠） */
export function usePathname(): string {
  const pathname = useNextPathname()
  const normalized = pathname.replace(/\/+$/, '')
  return normalized || '/'
}
