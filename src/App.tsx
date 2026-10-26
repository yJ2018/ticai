import { useCallback, useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { EntertainmentDisclaimer } from './features/disclaimer/EntertainmentDisclaimer'
import {
  ENTERTAINMENT_DISCLAIMER_PATHS,
  hideEntertainmentDisclaimerForever,
  isEntertainmentDisclaimerHidden,
} from './features/disclaimer/disclaimerPreferences'
import { applyPageMeta } from './features/seo/seo'
import { AppRouter } from './router/AppRouter'
import { navLinks } from './router/routes'
import { useAuthStore } from './store/authStore'

export default function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const [isDisclaimerOpen, setIsDisclaimerOpen] = useState(false)
  const [isNavOpen, setIsNavOpen] = useState(false)
  const lastPathRef = useRef<string | null>(null)
  const disclaimerPathRef = useRef<string | null>(null)

  const user = useAuthStore((state) => state.user)
  const token = useAuthStore((state) => state.token)
  const signOut = useAuthStore((state) => state.signOut)

  // 刷新后校验一次本地 token；失效就静默清掉，站点继续以未登录状态工作
  useEffect(() => {
    void useAuthStore.getState().validate()
  }, [])

  // 跳转后自动收起移动端菜单，避免菜单盖住新页面
  useEffect(() => {
    setIsNavOpen(false)
  }, [location.pathname])

  // 路由级 SEO：标题、描述、canonical、robots
  useEffect(() => {
    applyPageMeta(normalizePath(location.pathname))
  }, [location.pathname])

  async function handleSignOut() {
    setIsNavOpen(false)
    await signOut()
    if (location.pathname.startsWith('/my-bets')) {
      navigate('/', { replace: true })
    }
  }

  useEffect(() => {
    const path = normalizePath(location.pathname)
    if (lastPathRef.current === path) {
      return
    }
    lastPathRef.current = path

    // 从「我的投注」带方案跳回投注页时，不再弹娱乐提示，
    // 否则它会盖在自动打开的方案弹层上面，多一次点击。
    const navState = location.state as { applyBet?: unknown } | null
    if (navState?.applyBet) {
      disclaimerPathRef.current = null
      setIsDisclaimerOpen(false)
      return
    }

    if (!ENTERTAINMENT_DISCLAIMER_PATHS.includes(path) || isEntertainmentDisclaimerHidden(path)) {
      disclaimerPathRef.current = null
      setIsDisclaimerOpen(false)
      return
    }

    disclaimerPathRef.current = path
    setIsDisclaimerOpen(true)
  }, [location.pathname, location.state])

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
        <header className={`app-topbar${isNavOpen ? ' is-nav-open' : ''}`}>
          <div className="app-topbar__title">
            <strong>体彩助手</strong>
            <span>赛事投注与开奖历史</span>
          </div>
          <nav
            id="app-topbar-nav"
            className={`app-topbar__nav${isNavOpen ? ' is-open' : ''}`}
            aria-label="主导航"
          >
            {navLinks.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `app-topbar__link${isActive ? ' is-active' : ''}`}
              >
                {item.label}
              </NavLink>
            ))}
            {token && (
              <button
                type="button"
                className="app-topbar__signout app-topbar__signout--menu"
                onClick={handleSignOut}
              >
                退出登录
              </button>
            )}
          </nav>
          <div className="app-topbar__user">
            {token && user ? (
              <>
                <NavLink to="/account" className="app-topbar__user-email" title="账号与登录方式">
                  {user.displayName || user.email || '我的账号'}
                </NavLink>
                <button
                  type="button"
                  className="app-topbar__signout app-topbar__signout--desktop"
                  onClick={handleSignOut}
                >
                  退出
                </button>
              </>
            ) : (
              <NavLink to="/login" className="app-topbar__login">
                登录
              </NavLink>
            )}
            <button
              type="button"
              className="app-topbar__toggle"
              aria-label={isNavOpen ? '收起导航' : '展开导航'}
              aria-expanded={isNavOpen}
              aria-controls="app-topbar-nav"
              onClick={() => setIsNavOpen((open) => !open)}
            >
              <span aria-hidden="true" />
              <span aria-hidden="true" />
              <span aria-hidden="true" />
            </button>
          </div>
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
