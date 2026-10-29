import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'

import { EntertainmentDisclaimer } from './features/disclaimer/EntertainmentDisclaimer'
import {
  ENTERTAINMENT_DISCLAIMER_PATHS,
  hideEntertainmentDisclaimerForever,
  isEntertainmentDisclaimerHidden,
} from './features/disclaimer/disclaimerPreferences'
import { applyPageMeta } from './features/seo/seo'
import { useNavigate, usePathname } from './lib/navigation'
import { useNavigationState } from './lib/nav-state'
import { KeepAliveRoutes } from './router/KeepAliveRoutes'
import { appRoutes, navLinks } from './router/routes'
import { useAuthStore } from './store/authStore'

export default function App() {
  const pathname = usePathname()
  const navigate = useNavigate()
  const navState = useNavigationState<{ applyBet?: unknown }>()
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
  }, [pathname])

  // 路由级 SEO：客户端只在导航时补一次；首屏的 title/canonical 由服务端 generateMetadata 产出
  useEffect(() => {
    applyPageMeta(pathname)
  }, [pathname])

  async function handleSignOut() {
    setIsNavOpen(false)
    await signOut()
    if (pathname.startsWith('/my-bets')) {
      navigate('/', { replace: true })
    }
  }

  useEffect(() => {
    if (lastPathRef.current === pathname) {
      return
    }
    lastPathRef.current = pathname

    // 从「我的投注」带方案跳回投注页时，不再弹娱乐提示，
    // 否则它会盖在自动打开的方案弹层上面，多一次点击。
    if (navState?.applyBet) {
      disclaimerPathRef.current = null
      setIsDisclaimerOpen(false)
      return
    }

    if (
      !ENTERTAINMENT_DISCLAIMER_PATHS.includes(pathname) ||
      isEntertainmentDisclaimerHidden(pathname)
    ) {
      disclaimerPathRef.current = null
      setIsDisclaimerOpen(false)
      return
    }

    disclaimerPathRef.current = pathname
    setIsDisclaimerOpen(true)
  }, [pathname, navState])

  const handleDisclaimerDismiss = useCallback((hideForever: boolean) => {
    if (hideForever && disclaimerPathRef.current) {
      hideEntertainmentDisclaimerForever(disclaimerPathRef.current)
    }
    setIsDisclaimerOpen(false)
  }, [])

  const isFullscreen = isFullscreenRoute(pathname)

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
              <Link
                key={item.to}
                href={item.to}
                prefetch={false}
                className={`app-topbar__link${isActivePath(pathname, item.to) ? ' is-active' : ''}`}
              >
                {item.label}
              </Link>
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
                <Link
                  href="/account"
                  prefetch={false}
                  className="app-topbar__user-email"
                  title="账号与登录方式"
                >
                  {user.displayName || user.email || '我的账号'}
                </Link>
                <button
                  type="button"
                  className="app-topbar__signout app-topbar__signout--desktop"
                  onClick={handleSignOut}
                >
                  退出
                </button>
              </>
            ) : (
              <Link href="/login" prefetch={false} className="app-topbar__login">
                登录
              </Link>
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
        <KeepAliveRoutes routes={appRoutes} pathname={pathname} />
      </main>
      <EntertainmentDisclaimer open={isDisclaimerOpen} onDismiss={handleDisclaimerDismiss} />
    </div>
  )
}

/** 这些路由自带导航栏，渲染时隐藏站点头部 */
function isFullscreenRoute(pathname: string) {
  return pathname.startsWith('/match/')
}

function isActivePath(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href
}
