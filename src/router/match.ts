/**
 * 路由匹配（纯函数，服务端和客户端共用）。
 *
 * 只支持 `:param` 一种动态段——项目里只有 `/match/:matchId` 用到，
 * 不为此引入 react-router。
 */

export function matchRoutePath(pattern: string, pathname: string): Record<string, string> | null {
  const patternSegments = pattern.split('/').filter(Boolean)
  const pathSegments = pathname.split('/').filter(Boolean)

  if (patternSegments.length !== pathSegments.length) {
    return null
  }

  const params: Record<string, string> = {}
  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index]
    const pathSegment = pathSegments[index]

    if (patternSegment.startsWith(':')) {
      params[patternSegment.slice(1)] = decodeURIComponent(pathSegment)
      continue
    }

    if (patternSegment !== pathSegment) {
      return null
    }
  }

  return params
}

/** 去掉查询串和结尾斜杠，统一成 `/a/b` 形式 */
export function normalizePathname(pathname: string): string {
  const [path] = String(pathname || '/').split('?')
  const normalized = path.replace(/\/+$/, '')
  return normalized || '/'
}
