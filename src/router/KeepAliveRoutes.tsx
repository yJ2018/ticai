import { useEffect, useRef } from 'react'

import { matchRoutePath } from './match'
import { type KeepAliveRouteItem } from './types'

type KeepAliveRoutesProps = {
  routes: KeepAliveRouteItem[]
  pathname: string
}

/**
 * 路由级 Keep-Alive：切走的页面保持挂载（`display` 切换），滚动位置与输入状态不丢。
 *
 * 与 react-router 版本相比只改两点：
 *   - 当前路径从 props 来（Next 的 `usePathname()`），不再依赖路由上下文；
 *   - 未匹配返回 null——路径是否存在由服务端页面判定（不存在直接 `notFound()`）。
 *
 * 首帧只渲染命中的那一屏，所以 SSR 出来的 HTML 里不会混入其它页面。
 */
export function KeepAliveRoutes({ routes, pathname }: KeepAliveRoutesProps) {
  const cachedPathsRef = useRef<string[]>([])
  const matchedRoute = routes.find((route) => matchRoutePath(route.path, pathname))

  useEffect(() => {
    if (matchedRoute?.cache && !cachedPathsRef.current.includes(matchedRoute.path)) {
      cachedPathsRef.current = [...cachedPathsRef.current, matchedRoute.path]
    }
  }, [matchedRoute])

  if (!matchedRoute) {
    return null
  }

  return (
    <>
      {routes.map((route) => {
        const matched = Boolean(matchRoutePath(route.path, pathname))
        const isCached = route.cache && cachedPathsRef.current.includes(route.path)

        if (!matched && !isCached) {
          return null
        }

        return (
          <section
            key={route.path}
            className={`keep-alive-route-pane${matched ? ' is-active' : ''}`}
            style={{ display: matched ? 'block' : 'none' }}
          >
            {route.element}
          </section>
        )
      })}
    </>
  )
}
