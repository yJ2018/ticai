import { NavLink } from 'react-router-dom'
import { AppRouter } from './router/AppRouter'
import { navLinks } from './router/routes'

export default function App() {
  return (
    <div className="app-shell">
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
      <main className="app-main">
        <AppRouter />
      </main>
    </div>
  )
}
