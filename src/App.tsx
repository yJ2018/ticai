import { useCallback, useEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { EntertainmentDisclaimer } from './features/disclaimer/EntertainmentDisclaimer'
import {
  ENTERTAINMENT_DISCLAIMER_PATHS,
  hideEntertainmentDisclaimerForever,
  isEntertainmentDisclaimerHidden,
} from './features/disclaimer/disclaimerPreferences'
import { AppRouter } from './router/AppRouter'
import { navLinks } from './router/routes'

export default function App() {
  const location = useLocation()
  const [isDisclaimerOpen, setIsDisclaimerOpen] = useState(false)
  const lastPathRef = useRef<string | null>(null)
  const disclaimerPathRef = useRef<string | null>(null)

  useEffect(() => {
    const path = normalizePath(location.pathname)
    if (lastPathRef.current === path) {
      return
    }
    lastPathRef.current = path

    if (!ENTERTAINMENT_DISCLAIMER_PATHS.includes(path) || isEntertainmentDisclaimerHidden(path)) {
      disclaimerPathRef.current = null
      setIsDisclaimerOpen(false)
      return
    }

    disclaimerPathRef.current = path
    setIsDisclaimerOpen(true)
  }, [location.pathname])

  const handleDisclaimerDismiss = useCallback((hideForever: boolean) => {
    if (hideForever && disclaimerPathRef.current) {
      hideEntertainmentDisclaimerForever(disclaimerPathRef.current)
    }
    setIsDisclaimerOpen(false)
  }, [])

  const isFullscreen = isFullscreenRoute(location.pathname)

  return (
    <div className={`app-shell${isFullscreen ? ' app-shell--fullscreen' : ''}`}>
      {/* H5 对战详情是全屏页面，带自己的返回栏，不需要站点头部 */}
      {!isFullscreen && (
        <header className="app-topbar">
          <div className="app-topbar__title">
            <strong>体彩助手</strong>
            <span>赛事投注与开奖历史</span>
          </div>
          <nav className="app-topbar__nav" aria-label="主导航">
            {navLinks.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `app-topbar__link${isActive ? ' is-active' : ''}`}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </header>
      )}
      <main className="app-main">
        <AppRouter />
      </main>
      <EntertainmentDisclaimer open={isDisclaimerOpen} onDismiss={handleDisclaimerDismiss} />
    </div>
  )
}

/** 这些路由自带导航栏，渲染时隐藏站点头部 */
function isFullscreenRoute(pathname: string) {
  return pathname.startsWith('/match/')
}

function normalizePath(pathname: string) {
  return pathname.replace(/\/+$/, '') || '/'
}
