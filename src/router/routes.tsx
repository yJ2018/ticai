import { AboutPage } from '../pages/AboutPage'
import { HistoryAnalysisPage } from '../pages/HistoryAnalysisPage'
import { HistoryPage } from '../pages/HistoryPage'
import { HomePage } from '../pages/HomePage'
import { HoroscopePage } from '../pages/HoroscopePage'
import { MathTrendAnalysisPage } from '../pages/MathTrendAnalysisPage'
import { MatchDetailPage } from '../pages/MatchDetailPage'
import { ProfilePage } from '../pages/ProfilePage'
import { type KeepAliveRouteItem, type NavItem } from './types'

export const appRoutes: KeepAliveRouteItem[] = [
  { path: '/', element: <HomePage />, cache: true },
  { path: '/history', element: <HistoryPage />, cache: true },
  { path: '/history-analysis', element: <HistoryAnalysisPage />, cache: true },
  { path: '/math-trend-analysis', element: <MathTrendAnalysisPage />, cache: true },
  // H5 对战详情：不缓存，换一场要重新拉数据
  { path: '/match/:matchId', element: <MatchDetailPage />, cache: false },
  { path: '/horoscope', element: <HoroscopePage />, cache: true },
  { path: '/about', element: <AboutPage />, cache: true },
  { path: '/profile', element: <ProfilePage />, cache: false },
]

export const navLinks: NavItem[] = [
  { to: '/', label: '赛事投注' },
  { to: '/history', label: '开奖历史' },
  { to: '/history-analysis', label: '分析页面' },
  { to: '/math-trend-analysis', label: '数学走势' },
  { to: '/horoscope', label: '星座运势' },
]
