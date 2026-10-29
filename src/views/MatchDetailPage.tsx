import { useEffect, useState } from 'react'
import { useNavigate, usePathname } from '../lib/navigation'
import { readNavigationState } from '../lib/nav-state'
import { matchRoutePath } from '../router/match'

import { type MatchCard } from '../service/matchService'
import { MatchDetailContent } from '../features/matchDetail/MatchDetailContent'
import { buildDetailView } from '../features/matchDetail/matchDetailView'
import { useMatchDetail } from '../features/matchDetail/useMatchDetail'
import { applyPageMeta } from '../features/seo/seo'
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
  const pathname = usePathname()
  const [cachedMatch] = useState(() => readNavigationState<MatchDetailLocationState>()?.match)

  const routeId = matchRoutePath('/match/:matchId', pathname)?.matchId
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
  }, [pathname])

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

  // 比分页的标题更具体：等队名拿到后再覆盖一次 App 里的通用 meta
  useEffect(() => {
    if (!Number.isFinite(numericId)) {
      return
    }
    applyPageMeta(`/match/${numericId}`, {
      title: `${title} · 竞彩赔率与数据分析`,
      description: `${title}：竞彩足球赛前数据、赔率走势与历史交锋分析，附胜平负与比分参考。`,
    })
  }, [numericId, title])

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
