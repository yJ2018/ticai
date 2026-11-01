import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'

import { ApiError } from '../api/httpClient'
import { getMatchResults, type MatchResultItem, type ResultPeriod } from '../api/resultsApi'
import { useInitialResults } from '../ssr/initial-context'

/**
 * 赛果开奖（读 `match_result`）。
 *
 * 数据由本地爬虫每 30 分钟补齐。翻页按**期（销售日）**而不是自然日：
 * 竞彩按「周X」分期，周六 001–0xx 从周六下午一直排到周日凌晨，
 * 按日期切会把同一期拆成两天（周六 021 开赛在周日 01:00）。
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

/** 北京时间下的 YYYY-MM-DD（开赛日与期比较，判断是否跨天） */
function shanghaiDay(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function formatClock(value: string | null) {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return date.toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 开赛时间：同一期内的跨天场次标「次日」，避免和期号对不上。 */
function formatKickoff(value: string | null, period: string) {
  const clock = formatClock(value)
  if (!clock || !value || !period) {
    return clock
  }
  const day = shanghaiDay(value)
  if (!day || day === period) {
    return clock
  }
  const diff = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${period}T00:00:00Z`)) / 86_400_000)
  return diff === 1 ? `次日 ${clock}` : `${day.slice(5)} ${clock}`
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

function ResultCard({ item, period }: { item: MatchResultItem; period: string }) {
  const settled = item.settled && item.homeScore !== null && item.awayScore !== null

  return (
    <li className={`result-card${settled ? ' is-settled' : ''}`}>
      <div className="result-card__head">
        <span className="result-card__no">{item.matchNo || '—'}</span>
        {item.kickoffAt && <span className="result-card__time">{formatKickoff(item.kickoffAt, period)}</span>}
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
  // 服务端预取过最近一期的赛果：首帧直接用，不再等一次请求
  const initial = useInitialResults()
  const [period, setPeriod] = useState(() => initial?.period ?? '')
  const [label, setLabel] = useState(() => initial?.label ?? '')
  const [periods, setPeriods] = useState<ResultPeriod[]>(() => initial?.periods ?? [])
  const [items, setItems] = useState<MatchResultItem[]>(() => initial?.items ?? [])
  const [updatedAt, setUpdatedAt] = useState<string | null>(() => initial?.updatedAt ?? null)
  const [loading, setLoading] = useState(() => !initial)
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const requestRef = useRef(0)

  const load = useCallback(async (targetPeriod: string) => {
    // 期切换条点得快时会连发几次请求，只认最后一次的结果，别让旧响应盖掉新期
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    setLoading(true)
    setError('')
    try {
      const data = await getMatchResults({ period: targetPeriod || undefined, limit: 500 })
      if (requestRef.current !== requestId) {
        return
      }
      setPeriod(data.period)
      setLabel(data.label)
      setPeriods(data.periods)
      setItems(data.items)
      setUpdatedAt(data.updatedAt)
    } catch (loadError) {
      if (requestRef.current !== requestId) {
        return
      }
      setError(describeError(loadError))
      setItems([])
    } finally {
      if (requestRef.current === requestId) {
        setLoading(false)
      }
    }
  }, [])

  // 首帧已经有服务端数据时跳过这一次重复请求；换期仍然照常拉
  useEffect(() => {
    if (initial) {
      return
    }
    void load('')
  }, [initial, load])

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

  const periodIndex = useMemo(() => periods.findIndex((item) => item.period === period), [period, periods])
  const newerPeriod = periodIndex > 0 ? periods[periodIndex - 1] : periodIndex < 0 ? periods[0] : null
  const olderPeriod = periodIndex >= 0 ? periods[periodIndex + 1] ?? null : null
  const isLatest = periods.length > 0 && period === periods[0].period

  function selectPeriod(next: string) {
    if (!next || next === period) {
      return
    }
    setPeriod(next)
    setStatusFilter('all')
    void load(next)
  }

  return (
    <section className="results-page">
      <h1 className="visually-hidden">竞彩足球开奖结果与奖金</h1>
      <header className="results-page__header">
        <div>
          <p className="results-page__eyebrow">体彩官网开奖数据</p>
          <h2>赛果开奖</h2>
          <p className="results-page__sub">
            比分与胜平负 / 让球 / 总进球 / 半全场 / 比分结果，开奖后 30 分钟内入库。
            按期（销售日）查看：跨零点场次归前一天，例如周六 021 踢在周日 01:00，仍算周六这一期
            {updatedAt && <span className="results-page__updated"> · 更新于 {formatClock(updatedAt)}</span>}
          </p>
        </div>
        <div className="results-page__links">
          <Link className="btn-ghost" href="/odds-distribution">
            赔率分布
          </Link>
          <Link className="btn-ghost" href="/">
            去投注
          </Link>
        </div>
      </header>

      <div className="results-toolbar">
        <div className="results-period">
          <button
            type="button"
            className="results-period__step"
            onClick={() => olderPeriod && selectPeriod(olderPeriod.period)}
            disabled={!olderPeriod}
            aria-label="上一期"
          >
            ‹
          </button>
          <div className="results-period__current">
            <strong>{label || '—'}</strong>
            <span>
              {period ? period.slice(5).replace('-', '/') : '—'} · {items.length} 场
            </span>
          </div>
          <button
            type="button"
            className="results-period__step"
            onClick={() => newerPeriod && selectPeriod(newerPeriod.period)}
            disabled={!newerPeriod}
            aria-label="下一期"
          >
            ›
          </button>
          {!isLatest && periods.length > 0 && (
            <button type="button" className="results-period__latest" onClick={() => selectPeriod(periods[0].period)}>
              最新
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

        <div className="results-periods" role="tablist" aria-label="按期选择">
          {periods.map((item) => (
            <button
              key={item.period}
              type="button"
              role="tab"
              aria-selected={item.period === period}
              className={`results-periods__item${item.period === period ? ' is-active' : ''}`}
              onClick={() => selectPeriod(item.period)}
            >
              <strong>{item.label}</strong>
              <span>{item.period.slice(5).replace('-', '/')}</span>
              <em>{item.count}</em>
            </button>
          ))}
        </div>
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
          <button type="button" className="btn-ghost" onClick={() => void load(period)}>
            重试
          </button>
        </div>
      )}

      {!loading && !error && visibleItems.length === 0 && (
        <div className="results-status">
          <p>{items.length === 0 ? '这一期还没有赛果记录' : '当前筛选条件下没有比赛'}</p>
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
            <ResultCard key={item.matchId} item={item} period={period} />
          ))}
        </ul>
      )}
    </section>
  )
}
