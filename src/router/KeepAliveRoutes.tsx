import { useEffect, useRef } from 'react'
import { Navigate, matchPath, useLocation } from 'react-router-dom'
import { type KeepAliveRouteItem } from './types'

type KeepAliveRoutesProps = {
  routes: KeepAliveRouteItem[]
  fallbackPath?: string
}

export function KeepAliveRoutes({ routes, fallbackPath = '/' }: KeepAliveRoutesProps) {
  const location = useLocation()
  const cachedPathsRef = useRef<string[]>([])
  const pathname = location.pathname

  const matchedRoute = routes.find((route) => isRouteMatched(route.path, pathname))

  useEffect(() => {
    if (matchedRoute?.cache && !cachedPathsRef.current.includes(matchedRoute.path)) {
      cachedPathsRef.current = [...cachedPathsRef.current, matchedRoute.path]
    }
  }, [matchedRoute])

  if (!matchedRoute) {
    return <Navigate to={fallbackPath} replace />
  }

  return (
    <>
      {routes.map((route) => {
        const matched = isRouteMatched(route.path, pathname)
        const isCached = route.cache && cachedPathsRef.current.includes(route.path)
        const shouldRender = matched || isCached

        if (!shouldRender) {
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

function isRouteMatched(routePath: string, pathname: string) {
  return Boolean(matchPath({ path: routePath, end: true }, pathname))
}
