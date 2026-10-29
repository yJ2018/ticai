import { matchRoutePath, normalizePathname } from './match'

/**
 * 应用路由清单（纯数据 + 匹配，不 import 任何页面组件）。
 *
 * 服务端用它判断「这个路径存不存在」（不存在直接 404），
 * 客户端用它决定 Keep-Alive 里该显示哪一屏。
 * 带组件的表在 `routes.tsx`，两者路径必须一一对应。
 */

export type AppRouteManifestItem = {
  path: string
  /** 是否缓存（切走不卸载） */
  cache: boolean
  /** 需要登录的页面：不在 sitemap、noindex */
  private?: boolean
}

export const appRouteManifest: AppRouteManifestItem[] = [
  { path: '/', cache: true },
  { path: '/history', cache: true },
  { path: '/results', cache: false },
  { path: '/history-analysis', cache: true },
  { path: '/math-trend-analysis', cache: true },
  { path: '/match/:matchId', cache: false },
  { path: '/horoscope', cache: true },
  { path: '/about', cache: true },
  { path: '/login', cache: false, private: true },
  { path: '/auth/wechat', cache: false, private: true },
  { path: '/account', cache: false, private: true },
  { path: '/my-bets', cache: false, private: true },
  { path: '/profile', cache: false, private: true },
]

export type MatchedAppRoute = {
  route: AppRouteManifestItem
  params: Record<string, string>
  pathname: string
}

export function matchAppRoute(pathname: string): MatchedAppRoute | null {
  const normalized = normalizePathname(pathname)
  for (const route of appRouteManifest) {
    const params = matchRoutePath(route.path, normalized)
    if (params) {
      return { route, params, pathname: normalized }
    }
  }
  return null
}

/** 公开（可索引）路由，用于 sitemap 与 SSR 缓存策略 */
export function isPublicPath(pathname: string): boolean {
  const matched = matchAppRoute(pathname)
  return Boolean(matched && !matched.route.private)
}
