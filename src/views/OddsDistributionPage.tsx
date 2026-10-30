import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { ApiError } from '../api/httpClient'
import {
  getOddsDistribution,
  type OddsDistribution,
  type TtgBin,
  type TtgRank,
  type TtgSeries,
  type TtgSeriesKey,
} from '../api/oddsDistributionApi'

/**
 * 总进球赔率分布（/odds-distribution）。
 *
 * 数据来自 `GET /api/odds-distribution`：服务端把「已开奖 + 赛前有总进球赔率」
 * 的场次聚合成四条分布（最低 / 倒数第二低 / 第三低 / 中奖），这里只负责画图。
 * 不限时间，也没有日期筛选——库里有赔率的场次全部计入。
 */

const SERIES_META: Array<{ key: TtgSeriesKey; label: string }> = [
  { key: 'lowest', label: '最低赔率' },
  { key: 'second', label: '倒数第二低' },
  { key: 'third', label: '第三低' },
  { key: 'winning', label: '中奖赔率' },
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

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return '--'
  }
  return `${(value * 100).toFixed(1)}%`
}

function formatOdds(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return '--'
  }
  return value.toFixed(2)
}

function formatAmount(value: number) {
  return Number.isFinite(value) ? String(value) : '0'
}

function formatUpdateTime(value: string | null) {
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

function niceMax(value: number) {
  if (!Number.isFinite(value) || value <= 5) {
    return 5
  }
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * magnitude
}

export function OddsDistributionPage() {
  const [data, setData] = useState<OddsDistribution | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [hiddenSeries, setHiddenSeries] = useState<Set<TtgSeriesKey>>(() => new Set())

  const load = useCallback(async (signal?: AbortSignal, mode: 'initial' | 'refresh' = 'initial') => {
    if (mode === 'refresh') {
      setRefreshing(true)
    } else {
      setLoading(true)
    }
    setError('')

    try {
      const next = await getOddsDistribution(signal)
      if (!signal?.aborted) {
        setData(next)
      }
    } catch (loadError) {
      if (signal?.aborted || (loadError instanceof Error && loadError.name === 'AbortError')) {
        return
      }
      setError(describeError(loadError))
    } finally {
      if (!signal?.aborted) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const seriesByKey = useMemo(() => {
    const map = new Map<TtgSeriesKey, TtgSeries>()
    for (const item of data?.series ?? []) {
      map.set(item.key, item)
    }
    return map
  }, [data])

  const toggleSeries = useCallback((key: TtgSeriesKey) => {
    setHiddenSeries((previous) => {
      const next = new Set(previous)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  const updatedLabel = formatUpdateTime(data?.sample.updatedAt ?? null)

  return (
    <section className="odds-page">
      <h1 className="visually-hidden">竞彩足球总进球赔率分布</h1>

      <header className="odds-page__header">
        <div>
          <p className="odds-page__eyebrow">开奖记录 × 赛前总进球赔率</p>
          <h2>进球赔率分布</h2>
          <p className="odds-page__sub">
            每场已开奖比赛取 8 个总进球选项的赛前赔率，从低到高排序，统计最低 / 倒数第二低 /
            第三低与最终中奖赔率的分布。不限时间，库里有赔率的场次全部计入。
          </p>
        </div>
        <div className="odds-page__actions">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => void load(undefined, 'refresh')}
            disabled={refreshing}
          >
            {refreshing ? '刷新中…' : '刷新'}
          </button>
          <Link className="btn-ghost" href="/results">
            看赛果
          </Link>
        </div>
      </header>

      {loading && <OddsSkeleton />}

      {!loading && error && (
        <div className="odds-status">
          <p>{error}</p>
          <button type="button" className="btn-ghost" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}

      {!loading && !error && data && data.sample.matches === 0 && (
        <div className="odds-status">
          <p>还没有可统计的样本：需要已开奖、且赛前有总进球赔率的比赛。</p>
          <p className="odds-status__hint">
            当前库里有总进球赛果 {formatAmount(data.sample.settledResults)} 场，但都还没匹配到赔率。
            等爬虫跑过一轮赛果与赔率后会自动出现。
          </p>
        </div>
      )}

      {!loading && !error && data && data.sample.matches > 0 && (
        <>
          <div className="odds-stats">
            <StatCard
              label="样本场次"
              value={String(data.sample.matches)}
              unit="场"
              hint={`${data.sample.from ?? '--'} ~ ${data.sample.to ?? '--'}`}
            />
            <StatCard
              label="最低赔率命中"
              value={formatPercent(data.highlights.lowestHitRate)}
              hint={`${data.highlights.lowestHits} 场开出最低赔率`}
              tone="lowest"
            />
            <StatCard
              label="前三低命中"
              value={formatPercent(data.highlights.top3HitRate)}
              hint={`${data.highlights.top3Hits} 场落在最低 / 第二低 / 第三低`}
              tone="third"
            />
            <StatCard
              label="平均最低 / 中奖"
              value={`${formatOdds(data.highlights.averageLowest)} / ${formatOdds(data.highlights.averageWinning)}`}
              hint={
                data.highlights.averageRatio
                  ? `中奖赔率平均是最低赔率的 ${data.highlights.averageRatio.toFixed(2)} 倍`
                  : '样本不足'
              }
              tone="winning"
            />
          </div>

          <p className="odds-coverage">
            库里有总进球赛果 <strong>{formatAmount(data.sample.settledResults)}</strong> 场，其中{' '}
            <strong>{formatAmount(data.sample.matches)}</strong> 场能匹配到赛前赔率（
            {formatPercent(data.sample.coverage)}）。
            {data.sample.skipped > 0 && ` ${data.sample.skipped} 场赔率字段不完整，已跳过。`}
            {updatedLabel && <span className="odds-coverage__updated"> · 更新于 {updatedLabel}</span>}
          </p>

          <article className="odds-card">
            <header className="odds-card__head">
              <div>
                <h3>四条赔率分布</h3>
                <p>横轴为赔率区间，纵轴为场次；点击图例可隐藏 / 显示单条曲线</p>
              </div>
              <div className="odds-legend" role="group" aria-label="赔率系列显示开关">
                {SERIES_META.map((meta) => {
                  const active = !hiddenSeries.has(meta.key)
                  const series = seriesByKey.get(meta.key)
                  return (
                    <button
                      key={meta.key}
                      type="button"
                      className={`odds-legend__item odds-legend__item--${meta.key}${
                        active ? '' : ' is-off'
                      }`}
                      aria-pressed={active}
                      onClick={() => toggleSeries(meta.key)}
                    >
                      <span className="odds-legend__dot" aria-hidden="true" />
                      <span>{meta.label}</span>
                      <em>{formatOdds(series?.average ?? null)}</em>
                    </button>
                  )
                })}
              </div>
            </header>

            <DistributionChart bins={data.bins} hiddenSeries={hiddenSeries} />

            <p className="odds-card__foot">
              中奖赔率 = 实际总进球选项的赛前赔率（7 表示 7+ 球）；赔率并列时共享排名。
            </p>
          </article>

          <article className="odds-card">
            <header className="odds-card__head">
              <div>
                <h3>中奖赔率排名</h3>
                <p>实际总进球在 8 个选项里的赔率排名；最低 / 第二低 / 第三低高亮显示</p>
              </div>
              <span className="odds-card__badge">
                前三低 {formatPercent(data.highlights.top3HitRate)}
              </span>
            </header>

            <RankChart ranks={data.ranks} total={data.sample.matches} />
          </article>

          <article className="odds-card">
            <header className="odds-card__head">
              <div>
                <h3>最近样本</h3>
                <p>按比赛日倒序，逐场对照最低赔率与最终中奖赔率</p>
              </div>
            </header>

            <div className="odds-table__scroll odds-table__scroll--recent">
              <table className="odds-table">
                <thead>
                  <tr>
                    <th scope="col">日期</th>
                    <th scope="col">比赛</th>
                    <th scope="col">比分</th>
                    <th scope="col">总进球</th>
                    <th scope="col" className="is-lowest">最低</th>
                    <th scope="col" className="is-second">倒数第二低</th>
                    <th scope="col" className="is-third">第三低</th>
                    <th scope="col" className="is-winning">中奖</th>
                    <th scope="col">排名</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((item) => (
                    <tr key={`${item.matchId}-${item.matchDate}`}>
                      <td className="odds-table__date">{item.matchDate || '--'}</td>
                      <td>
                        <span className="odds-table__match">
                          {item.homeName} vs {item.awayName}
                        </span>
                        <em className="odds-table__league">{item.leagueName || '未知联赛'}</em>
                      </td>
                      <td>{item.score ?? '--'}</td>
                      <td>{item.ttgLabel}</td>
                      <td className="is-lowest">{formatOdds(item.lowest)}</td>
                      <td className="is-second">{formatOdds(item.second)}</td>
                      <td className="is-third">{formatOdds(item.third)}</td>
                      <td className="is-winning">{formatOdds(item.winning)}</td>
                      <td>
                        <span className={`odds-rank${item.rank <= 3 ? ' is-top' : ''}`}>
                          {item.rankLabel}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="odds-samples">
              {data.recent.map((item) => (
                <li key={`${item.matchId}-${item.matchDate}`} className="odds-sample">
                  <div className="odds-sample__head">
                    <span className="odds-sample__date">{item.matchDate || '--'}</span>
                    <span className={`odds-rank${item.rank <= 3 ? ' is-top' : ''}`}>
                      {item.rankLabel}
                    </span>
                  </div>
                  <p className="odds-sample__teams">
                    {item.homeName} vs {item.awayName}
                  </p>
                  <p className="odds-sample__meta">
                    {item.leagueName || '未知联赛'} · 比分 {item.score ?? '--'} · 总进球{' '}
                    {item.ttgLabel}
                  </p>
                  <dl className="odds-sample__odds">
                    <div>
                      <dt>最低</dt>
                      <dd>{formatOdds(item.lowest)}</dd>
                    </div>
                    <div>
                      <dt>倒数第二低</dt>
                      <dd>{formatOdds(item.second)}</dd>
                    </div>
                    <div>
                      <dt>第三低</dt>
                      <dd>{formatOdds(item.third)}</dd>
                    </div>
                    <div className="is-winning">
                      <dt>中奖</dt>
                      <dd>{formatOdds(item.winning)}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>

            <details className="odds-details">
              <summary>查看分布区间数据</summary>
              <div className="odds-table__scroll">
                <table className="odds-table odds-table--bins">
                  <thead>
                    <tr>
                      <th scope="col">赔率区间</th>
                      <th scope="col" className="is-lowest">最低</th>
                      <th scope="col" className="is-second">倒数第二低</th>
                      <th scope="col" className="is-third">第三低</th>
                      <th scope="col" className="is-winning">中奖</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.bins.map((bin) => (
                      <tr key={bin.label}>
                        <td>{bin.label}</td>
                        <td className="is-lowest">{bin.lowest}</td>
                        <td className="is-second">{bin.second}</td>
                        <td className="is-third">{bin.third}</td>
                        <td className="is-winning">{bin.winning}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </article>
        </>
      )}
    </section>
  )
}

function StatCard({
  label,
  value,
  unit,
  hint,
  tone,
}: {
  label: string
  value: string
  unit?: string
  hint: string
  tone?: TtgSeriesKey
}) {
  return (
    <article className={`odds-stat${tone ? ` odds-stat--${tone}` : ''}`}>
      <span className="odds-stat__label">{label}</span>
      <strong className="odds-stat__value">
        {value}
        {unit && <small>{unit}</small>}
      </strong>
      <span className="odds-stat__hint">{hint}</span>
    </article>
  )
}

const CHART_WIDTH = 760
const CHART_HEIGHT = 300
const CHART_PADDING = { top: 18, right: 18, bottom: 42, left: 46 }

function DistributionChart({
  bins,
  hiddenSeries,
}: {
  bins: TtgBin[]
  hiddenSeries: Set<TtgSeriesKey>
}) {
  const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right
  const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom
  const bottom = CHART_PADDING.top + plotHeight
  const slot = bins.length > 0 ? plotWidth / bins.length : plotWidth

  const maxCount = bins.reduce(
    (max, bin) => Math.max(max, bin.lowest, bin.second, bin.third, bin.winning),
    0,
  )
  const yMax = niceMax(maxCount)
  const ticks = Array.from({ length: 6 }, (_, index) => (yMax / 5) * index)

  const x = (index: number) => CHART_PADDING.left + slot * (index + 0.5)
  const y = (value: number) => bottom - (value / yMax) * plotHeight

  const visibleSeries = SERIES_META.filter((meta) => !hiddenSeries.has(meta.key))
  const summary = visibleSeries
    .map((meta) => {
      const total = bins.reduce((sum, bin) => sum + bin[meta.key], 0)
      return `${meta.label} ${total} 场`
    })
    .join('，')

  return (
    <div className="odds-chart">
      <div className="odds-chart__scroll">
        <svg
          className="odds-chart__svg"
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          role="img"
          aria-label={`赔率分布：${summary}`}
        >
          <g className="odds-chart__grid">
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={CHART_PADDING.left}
                  x2={CHART_PADDING.left + plotWidth}
                  y1={y(tick)}
                  y2={y(tick)}
                />
                <text x={CHART_PADDING.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle">
                  {Math.round(tick)}
                </text>
              </g>
            ))}
          </g>

          {visibleSeries.map((meta) => {
            const points = bins.map((bin, index) => ({ x: x(index), y: y(bin[meta.key]) }))
            if (points.length === 0) {
              return null
            }
            const line = points
              .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`)
              .join(' ')
            const area = `${line} L${points[points.length - 1].x},${bottom} L${points[0].x},${bottom} Z`

            return (
              <g key={meta.key} className={`odds-chart__series odds-chart__series--${meta.key}`}>
                {meta.key === 'winning' && <path className="odds-chart__area" d={area} />}
                <path className="odds-chart__line" d={line} />
                {bins.map((bin, index) =>
                  bin[meta.key] > 0 ? (
                    <circle
                      key={`${meta.key}-${bin.label}`}
                      className="odds-chart__dot"
                      cx={x(index)}
                      cy={y(bin[meta.key])}
                      r={meta.key === 'winning' ? 3.4 : 2.2}
                    >
                      <title>
                        {meta.label} · {bin.label}：{bin[meta.key]} 场
                      </title>
                    </circle>
                  ) : null,
                )}
              </g>
            )
          })}

          <g className="odds-chart__xaxis">
            {bins.map((bin, index) => (
              <text key={bin.label} x={x(index)} y={CHART_HEIGHT - 16} textAnchor="middle">
                {bin.label}
              </text>
            ))}
          </g>
        </svg>
      </div>
      <p className="odds-chart__hint">左右滑动查看完整区间</p>
    </div>
  )
}

const RANK_WIDTH = 760
const RANK_HEIGHT = 250
const RANK_PADDING = { top: 22, right: 18, bottom: 50, left: 46 }

function RankChart({ ranks, total }: { ranks: TtgRank[]; total: number }) {
  const plotWidth = RANK_WIDTH - RANK_PADDING.left - RANK_PADDING.right
  const plotHeight = RANK_HEIGHT - RANK_PADDING.top - RANK_PADDING.bottom
  const bottom = RANK_PADDING.top + plotHeight
  const slot = ranks.length > 0 ? plotWidth / ranks.length : plotWidth
  const barWidth = Math.min(58, slot * 0.54)

  const maxCount = ranks.reduce((max, rank) => Math.max(max, rank.count), 0)
  const yMax = niceMax(maxCount)
  const ticks = Array.from({ length: 6 }, (_, index) => (yMax / 5) * index)
  const y = (value: number) => bottom - (value / yMax) * plotHeight
  const x = (index: number) => RANK_PADDING.left + slot * (index + 0.5)

  const top3 = ranks.slice(0, 3).reduce((sum, rank) => sum + rank.count, 0)

  return (
    <div className="odds-chart">
      <div className="odds-chart__scroll">
        <svg
          className="odds-chart__svg"
          viewBox={`0 0 ${RANK_WIDTH} ${RANK_HEIGHT}`}
          role="img"
          aria-label={`中奖赔率排名分布：共 ${total} 场，前三低 ${top3} 场`}
        >
          <g className="odds-chart__grid">
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={RANK_PADDING.left}
                  x2={RANK_PADDING.left + plotWidth}
                  y1={y(tick)}
                  y2={y(tick)}
                />
                <text
                  x={RANK_PADDING.left - 8}
                  y={y(tick)}
                  textAnchor="end"
                  dominantBaseline="middle"
                >
                  {Math.round(tick)}
                </text>
              </g>
            ))}
          </g>

          {ranks.map((rank, index) => {
            const barHeight = Math.max(0, bottom - y(rank.count))
            return (
              <g
                key={rank.rank}
                className={`odds-rankbar odds-rankbar--${rank.rank}${rank.rank <= 3 ? ' is-top' : ''}`}
              >
                <rect
                  x={x(index) - barWidth / 2}
                  y={y(rank.count)}
                  width={barWidth}
                  height={barHeight}
                  rx={6}
                >
                  <title>
                    {rank.label}：{rank.count} 场（{formatPercent(rank.rate)}）
                  </title>
                </rect>
                <text
                  className="odds-rankbar__value"
                  x={x(index)}
                  y={Math.max(RANK_PADDING.top + 4, y(rank.count) - 7)}
                  textAnchor="middle"
                >
                  {rank.count}
                </text>
                <text className="odds-rankbar__label" x={x(index)} y={bottom + 22} textAnchor="middle">
                  {rank.label}
                </text>
                <text className="odds-rankbar__rate" x={x(index)} y={bottom + 38} textAnchor="middle">
                  {formatPercent(rank.rate)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      <p className="odds-chart__hint">左右滑动查看完整排名</p>
    </div>
  )
}

function OddsSkeleton() {
  return (
    <div className="odds-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="visually-hidden">正在加载赔率分布…</span>
      <div className="odds-skeleton__stats" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <span key={index} className="odds-skeleton__stat" />
        ))}
      </div>
      <div className="odds-skeleton__card" aria-hidden="true">
        <span className="odds-skeleton__line" />
        <span className="odds-skeleton__chart" />
      </div>
    </div>
  )
}
