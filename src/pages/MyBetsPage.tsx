import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import {
  deleteBet,
  listBets,
  type Bet,
  type BetStats,
  type MarketPool,
} from '../api/betApi'
import { ApiError } from '../api/httpClient'
import { BetDetailModal } from '../features/bets/BetDetailModal'
import {
  OUTCOME_LABELS,
  POOL_FILTER_OPTIONS,
  POOL_LABELS,
  STATUS_LABELS,
  formatDateTime,
  formatMoney,
} from '../features/bets/format'
import { useAuthStore } from '../store/authStore'

/**
 * 我的投注。
 *
 * 结算状态由服务端按 match_result 实时重算，前端只负责展示与筛选：
 *   - 状态（待开奖 / 中奖 / 未中）在本地过滤，切 tab 不发请求；
 *   - 玩法（pool）由服务端过滤，切玩法重新拉第一页；
 *   - 分页 30 条，「加载更多」按 offset 累加；
 *   - 点任意一条投注打开详情弹层（与首页「查看方案」同一套交互）。
 */

const PAGE_SIZE = 30

type StatusFilter = 'all' | 'pending' | 'won' | 'lost'
type PoolFilter = MarketPool | ''

const STATUS_TABS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待开奖' },
  { value: 'won', label: '中奖' },
  { value: 'lost', label: '未中' },
]

function describeError(error: unknown) {
  if (error instanceof ApiError) {
    return error.message
  }
  if (error instanceof Error && error.message) {
    return error.message
  }
  return '请求失败，请稍后重试'
}

function removeBetFromStats(prev: BetStats | null, bet: Bet): BetStats | null {
  if (!prev) {
    return prev
  }
  const next: BetStats = { ...prev }
  next.total = Math.max(0, next.total - 1)
  next[bet.status] = Math.max(0, next[bet.status] - 1)
  next.amount = Math.max(0, Number((next.amount - bet.amount).toFixed(2)))
  next.payout = Math.max(0, Number((next.payout - bet.payout).toFixed(2)))
  return next
}

type BetCardProps = {
  bet: Bet
  deleting: boolean
  onDelete: (bet: Bet) => void
  onOpen: (bet: Bet) => void
}

function BetCard({ bet, deleting, onDelete, onOpen }: BetCardProps) {
  return (
    <article
      className={`bet-card bet-card--${bet.status}`}
      onClick={() => onOpen(bet)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(bet)
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`查看投注详情：${bet.title}`}
    >
      <header className="bet-card__head">
        <div className="bet-card__title">
          <h3>{bet.title}</h3>
          <p className="bet-card__meta">
            <span>{formatDateTime(bet.placedAt)}</span>
            <span>{bet.passTypes.join('、')}</span>
            <span>{bet.multiple} 倍</span>
            <span>{bet.units} 注</span>
            <span>{formatMoney(bet.amount)} 元</span>
          </p>
          {bet.note && <p className="bet-card__note">{bet.note}</p>}
        </div>
        <span className={`bet-badge bet-badge--${bet.status}`}>{STATUS_LABELS[bet.status]}</span>
      </header>

      <ul className="bet-legs">
        {bet.legs.map((leg) => (
          <li key={leg.id} className="bet-leg">
            <div className="bet-leg__main">
              <p className="bet-leg__match">
                <span className="bet-leg__no">{leg.matchNo}</span>
                {leg.leagueName && <span className="bet-leg__league">{leg.leagueName}</span>}
                <span className="bet-leg__teams">
                  {leg.homeName} vs {leg.awayName}
                </span>
              </p>
              <p className="bet-leg__pick">
                <span>{POOL_LABELS[leg.pool]}</span>
                <strong>{leg.optionLabel}</strong>
                <span className="bet-leg__odds">@{leg.odds.toFixed(2)}</span>
              </p>
            </div>
            <div className="bet-leg__side">
              {leg.result?.settled &&
                leg.result.homeScore !== null &&
                leg.result.awayScore !== null && (
                  <span className="bet-leg__score">
                    {leg.result.homeScore}:{leg.result.awayScore}
                  </span>
                )}
              <span className={`bet-leg__result bet-leg__result--${leg.outcome}`}>
                {OUTCOME_LABELS[leg.outcome]}
              </span>
            </div>
          </li>
        ))}
      </ul>

      <footer className="bet-card__foot">
        <div className="bet-card__passes">
          {bet.passTypeDetails.map((detail) => (
            <span
              key={detail.passType}
              className={`bet-pass-chip${detail.wonUnits > 0 ? ' is-won' : ''}`}
            >
              {detail.passType} {detail.wonUnits}/{detail.totalUnits} 注
            </span>
          ))}
        </div>
        <div className="bet-card__money">
          {bet.payout > 0 && (
            <span className="bet-card__payout">奖金 {formatMoney(bet.payout)} 元</span>
          )}
          {bet.status === 'pending' && bet.payout > 0 && (
            <span className="bet-card__hint">部分过关已中，等待其余场次开奖</span>
          )}
          <button
            type="button"
            className="bet-card__detail"
            onClick={(event) => {
              event.stopPropagation()
              onOpen(bet)
            }}
          >
            详情
          </button>
          <button
            type="button"
            className="bet-card__delete"
            aria-label={`删除投注 ${bet.title}`}
            disabled={deleting}
            onClick={(event) => {
              event.stopPropagation()
              onDelete(bet)
            }}
          >
            {deleting ? '删除中…' : '删除'}
          </button>
        </div>
      </footer>
    </article>
  )
}

export function MyBetsPage() {
  const navigate = useNavigate()
  const token = useAuthStore((state) => state.token)
  const user = useAuthStore((state) => state.user)
  const ready = useAuthStore((state) => state.ready)
  const signOut = useAuthStore((state) => state.signOut)

  const [items, setItems] = useState<Bet[]>([])
  const [stats, setStats] = useState<BetStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [poolFilter, setPoolFilter] = useState<PoolFilter>('')
  const [hasMore, setHasMore] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [detailBet, setDetailBet] = useState<Bet | null>(null)

  const requestRef = useRef(0)
  const nextOffsetRef = useRef(0)
  const signingOutRef = useRef(false)

  // 未登录直接送去登录页，登录成功后回到这里
  useEffect(() => {
    if (!ready || token || signingOutRef.current) {
      return
    }
    navigate('/login', { replace: true, state: { from: '/my-bets' } })
  }, [navigate, ready, token])

  const loadPage = useCallback(
    async (mode: 'reset' | 'more') => {
      if (!token) {
        return
      }

      const requestId = requestRef.current + 1
      requestRef.current = requestId
      const offset = mode === 'reset' ? 0 : nextOffsetRef.current

      if (mode === 'reset') {
        setLoading(true)
        // 换玩法时先清空：否则新条件下会短暂显示上一批（别的玩法）的记录
        setItems([])
        setHasMore(false)
      } else {
        setLoadingMore(true)
      }
      setError('')

      try {
        const data = await listBets(token, { limit: PAGE_SIZE, offset, pool: poolFilter })
        if (requestRef.current !== requestId) {
          return
        }
        setItems((prev) => (mode === 'reset' ? data.items : [...prev, ...data.items]))
        if (data.stats) {
          setStats(data.stats)
        }
        nextOffsetRef.current = offset + data.items.length
        setHasMore(data.items.length === PAGE_SIZE)
      } catch (loadError) {
        if (requestRef.current !== requestId) {
          return
        }
        if (loadError instanceof ApiError && loadError.status === 401) {
          await signOut()
          navigate('/login', { replace: true, state: { from: '/my-bets' } })
          return
        }
        setError(describeError(loadError))
      } finally {
        if (requestRef.current === requestId) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [navigate, poolFilter, signOut, token],
  )

  useEffect(() => {
    if (!ready || !token) {
      return
    }
    void loadPage('reset')
  }, [loadPage, ready, token])

  const visibleItems = useMemo(
    () => (statusFilter === 'all' ? items : items.filter((bet) => bet.status === statusFilter)),
    [items, statusFilter],
  )

  const hasFilters = statusFilter !== 'all' || poolFilter !== ''

  async function handleDelete(bet: Bet) {
    if (!token || deletingId) {
      return
    }
    const confirmed = window.confirm(`确定删除「${bet.title}」这条投注记录？删除后无法恢复。`)
    if (!confirmed) {
      return
    }

    setDeletingId(bet.id)
    try {
      await deleteBet(token, bet.id)
      setItems((prev) => prev.filter((item) => item.id !== bet.id))
      setStats((prev) => removeBetFromStats(prev, bet))
      setDetailBet((current) => (current?.id === bet.id ? null : current))
      nextOffsetRef.current = Math.max(0, nextOffsetRef.current - 1)
    } catch (deleteError) {
      setError(describeError(deleteError))
    } finally {
      setDeletingId(null)
    }
  }

  function handleSignOut() {
    signingOutRef.current = true
    void signOut()
    navigate('/', { replace: true })
  }

  function clearFilters() {
    setStatusFilter('all')
    setPoolFilter('')
  }

  const totalValue = stats
    ? String(stats.total)
    : loading || error
      ? '—'
      : String(items.length)

  const statItems = [
    { key: 'total', label: '总单数', value: totalValue, tone: '' },
    { key: 'pending', label: '待开奖', value: stats ? String(stats.pending) : '—', tone: 'pending' },
    { key: 'won', label: '中奖', value: stats ? String(stats.won) : '—', tone: 'won' },
    { key: 'lost', label: '未中', value: stats ? String(stats.lost) : '—', tone: 'lost' },
    { key: 'amount', label: '总投入', value: stats ? formatMoney(stats.amount) : '—', tone: '' },
    { key: 'payout', label: '总奖金', value: stats ? formatMoney(stats.payout) : '—', tone: 'won' },
  ]

  if (!ready) {
    return (
      <div className="bets-screen">
        <section className="bets-page">
          <p className="bets-status">正在读取登录状态…</p>
        </section>
      </div>
    )
  }

  if (!token) {
    return (
      <div className="bets-screen">
        <section className="bets-page">
          <p className="bets-status">正在跳转登录…</p>
        </section>
      </div>
    )
  }

  return (
    <div className="bets-screen">
      {/* 标题 + 统计是页面顶部固定的一条区域，不跟下面的列表一起滚动 */}
      <div className="bets-hero">
        <header className="bets-page__header">
          <div className="bets-page__heading">
            <Link to="/" className="bets-page__back">
              ← 返回
            </Link>
            <h2>我的投注</h2>
            <p className="bets-page__sub">
              当前账号 {user?.displayName || user?.email || '已登录'}
            </p>
          </div>
          <div className="bets-page__actions">
            <button type="button" className="btn-ghost" onClick={handleSignOut}>
              退出登录
            </button>
            <Link className="btn-primary bets-page__go" to="/">
              去投注
            </Link>
          </div>
        </header>

        <dl className="bets-stats">
          {statItems.map((item) => (
            <div key={item.key} className={`bets-stats__item${item.tone ? ` is-${item.tone}` : ''}`}>
              <dt>{item.label}</dt>
              <dd>{stats ? item.value : <span className="bets-skeleton__stat" aria-hidden="true" />}</dd>
            </div>
          ))}
        </dl>
      </div>

      <section className="bets-page">
        <div className="bets-filters">
        <nav className="bets-tabs" aria-label="按状态筛选">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              aria-pressed={statusFilter === tab.value}
              className={statusFilter === tab.value ? 'is-active' : ''}
              onClick={() => setStatusFilter(tab.value)}
            >
              {tab.label}
              {tab.value !== 'all' && stats && (
                <span className="bets-tabs__count">{stats[tab.value]}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="bets-pools" role="group" aria-label="按玩法筛选">
          {POOL_FILTER_OPTIONS.map((option) => (
            <button
              key={option.value || 'all'}
              type="button"
              aria-pressed={poolFilter === option.value}
              className={poolFilter === option.value ? 'is-active' : ''}
              onClick={() => setPoolFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {error && items.length > 0 && (
        <p className="bets-alert" role="alert">
          {error}
        </p>
      )}

      {loading && items.length === 0 && (
        <div className="bets-skeleton" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className="bets-skeleton__card">
              <div className="bets-skeleton__row">
                <span className="bets-skeleton__line bets-skeleton__line--title" />
                <span className="bets-skeleton__line bets-skeleton__line--badge" />
              </div>
              <span className="bets-skeleton__line bets-skeleton__line--meta" />
              {[0, 1, 2, 3].map((leg) => (
                <span key={leg} className="bets-skeleton__line bets-skeleton__line--leg" />
              ))}
            </div>
          ))}
        </div>
      )}

      {!loading && error && items.length === 0 && (
        <div className="bets-status bets-status--error">
          <p>{error}</p>
          <button type="button" className="btn-ghost" onClick={() => void loadPage('reset')}>
            重试
          </button>
        </div>
      )}

      {!loading && !error && visibleItems.length === 0 && (
        <div className="bets-empty">
          <p>
            {hasFilters
              ? hasMore
                ? '当前筛选条件下暂时没有记录，可以加载更多'
                : '当前筛选条件下没有投注记录'
              : '还没有保存过投注'}
          </p>
          {hasFilters ? (
            <button type="button" className="btn-ghost" onClick={clearFilters}>
              清除筛选
            </button>
          ) : (
            <Link className="btn-primary" to="/">
              去赛事投注
            </Link>
          )}
        </div>
      )}

      {visibleItems.length > 0 && (
        <ul className="bets-list">
          {visibleItems.map((bet) => (
            <li key={bet.id}>
              <BetCard
                bet={bet}
                deleting={deletingId === bet.id}
                onDelete={(item) => void handleDelete(item)}
                onOpen={(item) => setDetailBet(item)}
              />
            </li>
          ))}
        </ul>
      )}

      {hasMore && !loading && !error && (
        <div className="bets-more">
          {statusFilter !== 'all' && (
            <p className="bets-more__hint">状态筛选只作用于已加载的记录，加载更多可继续查看</p>
          )}
          <button
            type="button"
            className="btn-ghost"
            disabled={loadingMore}
            onClick={() => void loadPage('more')}
          >
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}
      </section>

      <BetDetailModal
        bet={detailBet}
        open={Boolean(detailBet)}
        deleting={Boolean(detailBet && deletingId === detailBet.id)}
        onClose={() => setDetailBet(null)}
        onDelete={(bet) => void handleDelete(bet)}
      />
    </div>
  )
}
