import { AboutPage } from '../views/AboutPage'
import { AccountPage } from '../views/AccountPage'
import { AuthPage } from '../views/AuthPage'
import { HistoryAnalysisPage } from '../views/HistoryAnalysisPage'
import { HistoryPage } from '../views/HistoryPage'
import { HomePage } from '../views/HomePage'
import { HoroscopePage } from '../views/HoroscopePage'
import { MathTrendAnalysisPage } from '../views/MathTrendAnalysisPage'
import { MatchDetailPage } from '../views/MatchDetailPage'
import { MyBetsPage } from '../views/MyBetsPage'
import { OddsDistributionPage } from '../views/OddsDistributionPage'
import { ProfilePage } from '../views/ProfilePage'
import { ResultsPage } from '../views/ResultsPage'
import { WechatCallbackPage } from '../views/WechatCallbackPage'
import { type KeepAliveRouteItem, type NavItem } from './types'

export const appRoutes: KeepAliveRouteItem[] = [
  { path: '/', element: <HomePage />, cache: true },
  { path: '/history', element: <HistoryPage />, cache: true },
  // 赛果开奖：按天翻页，不缓存，回来时重新拉最新开奖
  { path: '/results', element: <ResultsPage />, cache: false },
  // 赔率分布：不限时间，每次进入重新拉最新统计
  { path: '/odds-distribution', element: <OddsDistributionPage />, cache: false },
  { path: '/history-analysis', element: <HistoryAnalysisPage />, cache: true },
  { path: '/math-trend-analysis', element: <MathTrendAnalysisPage />, cache: true },
  // H5 对战详情：不缓存，换一场要重新拉数据
  { path: '/match/:matchId', element: <MatchDetailPage />, cache: false },
  { path: '/horoscope', element: <HoroscopePage />, cache: true },
  { path: '/about', element: <AboutPage />, cache: true },
  // 登录/注册：每次进入都重新挂载，避免残留上一次的错误提示
  { path: '/login', element: <AuthPage />, cache: false },
  // 微信回调：一次性票据换会话，必须每次都重新执行
  { path: '/auth/wechat', element: <WechatCallbackPage />, cache: false },
  // 账号页：登录方式与微信绑定
  { path: '/account', element: <AccountPage />, cache: false },
  // 我的投注：不缓存，回来时重新拉最新结算状态
  { path: '/my-bets', element: <MyBetsPage />, cache: false },
  { path: '/profile', element: <ProfilePage />, cache: false },
]

export const navLinks: NavItem[] = [
  { to: '/', label: '赛事投注' },
  { to: '/results', label: '赛果开奖' },
  { to: '/odds-distribution', label: '赔率分布' },
  { to: '/history', label: '开奖历史' },
  { to: '/history-analysis', label: '分析页面' },
  { to: '/math-trend-analysis', label: '数学走势' },
  { to: '/horoscope', label: '星座运势' },
  { to: '/my-bets', label: '我的投注' },
]
