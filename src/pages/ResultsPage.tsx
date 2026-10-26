import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { ApiError } from '../api/httpClient'
import { getMatchResults, type MatchResultItem } from '../api/resultsApi'

/**
 * 赛果开奖（读 `match_result`）。
 *
 * 数据由本地爬虫每 30 分钟补齐；这里只按比赛日翻页展示，
 * 不开奖的场次显示为「未开奖」，不做任何推算。
 */

type StatusFilter = 'all' | 'settled' | 'unsettled'

const STATUS_TABS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'settled', label: '已开奖' },
  { value: 'unsettled', label: '未开奖' },
]

const HAD_LABELS: Record<string, string> = { h: '胜', d: '平', a: '负' }
const HHAD_LABELS: Record<string, string> = { h: '让胜', d: '让平', a: '让负' }
const HAFU_LABELS: Record<string, string> = {
  hh: '胜胜',
  hd: '胜平',
  ha: '胜负',
  dh: '平胜',
  dd: '平平',
  da: '平负',
  ah: '负胜',
  ad: '负平',
  aa: '负负',
}

function shanghaiToday() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function addDays(date: string, offset: number) {
  const stamp = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(stamp)) {
    return date
  }
  return new Date(stamp + offset * 86_400_000).toISOString().slice(0, 10)
}

function formatClock(value: string | null) {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
}
function ttgLabel(value: number | null) {
  if (value === null) {
    return '—'
  }
  return value >= 7 ? '7+' : String(value)
}

function crsLabel(value: string | null) {
  if (!value) {
    return '—'
  }
  if (value === 's1sh') {
    return '胜其它'
  }
  if (value === 's1sd') {
    return '平其它'
  }
  if (value === 's1sa') {
    return '负其它'
  }
  const match = /^s(\d{2})s(\d{2})$/.exec(value)
  return match ? `${Number(match[1])}:${Number(match[2])}` : value
}

function describeError(error: unknown) {
  if (error instanceof ApiError) {
    return error.message
  }
  if (error instanceof Error && error.message) {
    return error.message
  }
  return '请求失败，请稍后重试'
}

function ResultCard({ item }: { item: MatchResultItem }) {
  const settled = item.settled && item.homeScore !== null && item.awayScore !== null

  return (
    <li className={`result-card${settled ? ' is-settled' : ''}`}>
      <div className="result-card__head">
        <span className="result-card__no">{item.matchNo || '—'}</span>
        {item.kickoffAt && <span className="result-card__time">{formatClock(item.kickoffAt)}</span>}
        <span className="result-card__league">{item.leagueName || '未知联赛'}</span>
        <span className={`result-card__state${settled ? ' is-settled' : ''}`}>
          {settled ? '已开奖' : '未开奖'}
        </span>
      </div>

      <div className="result-card__score">
        <span className="result-card__team">{item.homeName}</span>
        <strong className={settled ? '' : 'is-pending'}>
          {settled ? `${item.homeScore} : ${item.awayScore}` : 'VS'}
        </strong>
        <span className="result-card__team result-card__team--away">{item.awayName}</span>
      </div>

      {settled && (
        <p className="result-card__half">
          半场 {item.homeHalfScore ?? '-'} : {item.awayHalfScore ?? '-'}
          {item.goalLine !== null && <span className="result-card__goal-line">让球 {item.goalLine > 0 ? `+${item.goalLine}` : item.goalLine}</span>}
        </p>
      )}

      <dl className="result-card__markets">
        <div>
          <dt>胜平负</dt>
          <dd>{item.had ? HAD_LABELS[item.had] : '—'}</dd>
        </div>
        <div>
          <dt>让球</dt>
          <dd>{item.hhad ? HHAD_LABELS[item.hhad] : '—'}</dd>
        </div>
        <div>
          <dt>总进球</dt>
          <dd>{ttgLabel(item.ttg)}</dd>
        </div>
        <div>
          <dt>半全场</dt>
          <dd>{item.hafu ? HAFU_LABELS[item.hafu] ?? item.hafu : '—'}</dd>
        </div>
        <div>
          <dt>比分</dt>
          <dd>{crsLabel(item.crs)}</dd>
        </div>
      </dl>
    </li>
  )
}

export function ResultsPage() {
  const [date, setDate] = useState(shanghaiToday)
  const [items, setItems] = useState<MatchResultItem[]>([])
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const load = useCallback(async (targetDate: string) => {
    setLoading(true)
    setError('')
    try {
      const data = await getMatchResults({ date: targetDate, days: 1, limit: 500 })
      setItems(data.items)
      setUpdatedAt(data.updatedAt)
    } catch (loadError) {
      setError(describeError(loadError))
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(date)
  }, [date, load])

  const settledCount = useMemo(() => items.filter((item) => item.settled).length, [items])
  const visibleItems = useMemo(() => {
    if (statusFilter === 'settled') {
      return items.filter((item) => item.settled)
    }
    if (statusFilter === 'unsettled') {
      return items.filter((item) => !item.settled)
    }
    return items
  }, [items, statusFilter])

  const today = shanghaiToday()

  return (
    <section className="results-page">
      <h1 className="visually-hidden">竞彩足球开奖结果与奖金</h1>
      <header className="results-page__header">
        <div>
          <p className="results-page__eyebrow">体彩官网开奖数据</p>
          <h2>赛果开奖</h2>
          <p className="results-page__sub">
            比分与胜平负 / 让球 / 总进球 / 半全场 / 比分结果，开奖后 30 分钟内入库
            {updatedAt && <span className="results-page__updated"> · 更新于 {formatClock(updatedAt)}</span>}
          </p>
        </div>
        <Link className="btn-ghost results-page__link" to="/">
          去投注
        </Link>
      </header>

      <div className="results-toolbar">
        <div className="results-date">
          <button type="button" className="results-date__step" onClick={() => setDate(addDays(date, -1))} aria-label="前一天">
            ‹
          </button>
          <input
            type="date"
            className="results-date__input"
            value={date}
            max={today}
            onChange={(event) => {
              if (event.target.value) {
                setDate(event.target.value)
              }
            }}
            aria-label="选择比赛日"
          />
          <button
            type="button"
            className="results-date__step"
            onClick={() => setDate(addDays(date, 1))}
            disabled={date >= today}
            aria-label="后一天"
          >
            ›
          </button>
          {date !== today && (
            <button type="button" className="results-date__today" onClick={() => setDate(today)}>
              今天
            </button>
          )}
        </div>

        <nav className="results-tabs" aria-label="按状态筛选">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={statusFilter === tab.value ? 'is-active' : ''}
              aria-pressed={statusFilter === tab.value}
              onClick={() => setStatusFilter(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <p className="results-count">
          共 <strong>{items.length}</strong> 场 · 已开奖 <strong>{settledCount}</strong>
        </p>
      </div>

      {loading && (
        <ul className="results-list results-list--loading" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <li key={index} className="result-card result-card--skeleton" />
          ))}
        </ul>
      )}

      {!loading && error && (
        <div className="results-status">
          <p>{error}</p>
          <button type="button" className="btn-ghost" onClick={() => void load(date)}>
            重试
          </button>
        </div>
      )}

      {!loading && !error && visibleItems.length === 0 && (
        <div className="results-status">
          <p>{items.length === 0 ? '这一天没有赛果记录' : '当前筛选条件下没有比赛'}</p>
          {statusFilter !== 'all' && (
            <button type="button" className="btn-ghost" onClick={() => setStatusFilter('all')}>
              查看全部
            </button>
          )}
        </div>
      )}

      {!loading && !error && visibleItems.length > 0 && (
        <ul className="results-list">
          {visibleItems.map((item) => (
            <ResultCard key={item.matchId} item={item} />
          ))}
        </ul>
      )}
    </section>
  )
}
