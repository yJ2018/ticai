import { useEffect } from 'react'
import { matchPath, useLocation, useNavigate } from 'react-router-dom'

import { type MatchCard } from '../service/matchService'
import { MatchDetailContent } from '../features/matchDetail/MatchDetailContent'
import { buildDetailView } from '../features/matchDetail/matchDetailView'
import { useMatchDetail } from '../features/matchDetail/useMatchDetail'
import '../features/matchDetail/matchDetail.scss'

type MatchDetailLocationState = { match?: MatchCard } | null

/**
 * H5 端：独立页面（/match/:matchId）。
 *
 * 从列表点进来时通过 router state 带上 MatchCard，首屏就能显示队名；
 * 直接访问 URL 时只有 matchId，等接口返回再填充，期间显示加载态。
 */
export function MatchDetailPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const cachedMatch = (location.state as MatchDetailLocationState)?.match

  // 这个仓库没有 <Routes> 上下文（自研 KeepAliveRoutes），useParams() 会返回空对象，
  // 所以参数只能自己从 pathname 里 match 出来。
  const routeId = matchPath({ path: '/match/:matchId', end: true }, location.pathname)?.params
    .matchId
  const numericId = Number(routeId ?? cachedMatch?.id ?? Number.NaN)

  const { detail, loading, error } = useMatchDetail(Number.isFinite(numericId) ? numericId : null)

  const view = buildDetailView(detail, {
    homeTeam: cachedMatch?.homeTeam,
    awayTeam: cachedMatch?.awayTeam,
    league: cachedMatch?.subtitle,
    time: cachedMatch?.time,
  })

  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [location.pathname])

  function goBack() {
    if (window.history.length > 1) {
      navigate(-1)
      return
    }
    navigate('/')
  }

  const title = cachedMatch
    ? `${cachedMatch.homeTeam || '主队'} vs ${cachedMatch.awayTeam || '客队'}`
    : view
      ? `${view.homeName} vs ${view.awayName}`
      : '对战数据'

  return (
    <div className="md-page">
      <header className="md-page__bar">
        <button type="button" className="md-page__back" onClick={goBack} aria-label="返回">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <strong>{title}</strong>
      </header>

      <div className="md-page__scroll">
        <MatchDetailContent
          view={view}
          loading={loading}
          error={error}
          fallback={{
            homeTeam: cachedMatch?.homeTeam,
            awayTeam: cachedMatch?.awayTeam,
            league: cachedMatch?.subtitle,
          }}
        />
      </div>
    </div>
  )
}
