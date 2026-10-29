import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { EMPTY_PREDICTION_ANALYSIS, type HistoryPredictionAnalysis } from '../domain/analysisTypes'
import {
  formatDltBigSmall,
  formatDltOddEven,
  formatDltZones,
  getDltFrontIndicators,
} from '../domain/dltIndicators'
import { useAnalysisSnapshot } from '../features/analysis/useAnalysisSnapshot'
import { historyService, type LotteryHistoryEntry, type LotteryHistoryGameType } from '../service/historyService'
import { DltIndicatorRail } from '../components/DltIndicatorRail'
import { DltRecommendationPanel } from '../components/DltRecommendationPanel'
import { HistoryPageSkeleton } from '../components/HistoryPageSkeleton'

/** 服务端快照到达前先渲染空分析，避免布局跳动 */
const EMPTY_PREDICTION: HistoryPredictionAnalysis = EMPTY_PREDICTION_ANALYSIS

const historyTabs: Array<{ key: LotteryHistoryGameType; label: string }> = [
  { key: 'pl5', label: '排列五' },
  { key: 'qxc', label: '七星彩' },
  { key: 'dlt', label: '大乐透' },
]
const TREND_DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
const POSITION_LABELS = ['第一位', '第二位', '第三位', '第四位', '第五位', '第六位', '第七位']
const DIGIT_AXIS = TREND_DIGITS
const FRONT_AXIS = Array.from({ length: 35 }, (_, index) => index + 1)
const BACK_AXIS = Array.from({ length: 12 }, (_, index) => index + 1)
/** 大乐透前区 5 条线、后区 2 条线，各自一种颜色 */
const FRONT_COLORS = ['#ea580c', '#db2777', '#7c3aed', '#0891b2', '#65a30d']
const BACK_COLORS = ['#2563eb', '#0ea5e9']

type GameMeta = {
  label: string
  /** 是否是按位次计数的彩种（排列五 / 七星彩），大乐透不是 */
  positional: boolean
  mainCount: number
  extraCount: number
  /** 最后一位是特殊号（七星彩的第七位） */
  specialLast: boolean
  unit: string
}

const GAME_META: Record<LotteryHistoryGameType, GameMeta> = {
  pl5: { label: '排列五', positional: true, mainCount: 5, extraCount: 0, specialLast: false, unit: '位' },
  qxc: { label: '七星彩', positional: true, mainCount: 7, extraCount: 0, specialLast: true, unit: '位' },
  dlt: { label: '大乐透', positional: false, mainCount: 5, extraCount: 2, specialLast: false, unit: '个' },
}
/**
 * 请求锁窗口：既保证按钮转圈"看得见"，也把连点吸收掉。
 * 700ms 覆盖常见的双击 / 连点节奏（含新页入场动画的 220ms），
 * 期间按钮 disabled + pointer-events:none，真实鼠标点击命中不到它。
 */
const HISTORY_MIN_BUSY_MS = 700

function waitAtLeast(startedAt: number, minDuration: number) {
  const remaining = minDuration - (Date.now() - startedAt)
  if (remaining <= 0) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, remaining)
  })
}

type HistoryState = {
  loading: boolean
  error: string
  items: LotteryHistoryEntry[]
  pageNo: number
  total: number
  pages: number
}

const initialState: HistoryState = {
  loading: true,
  error: '',
  items: [],
  pageNo: 1,
  total: 0,
  pages: 1,
}

type PageDirection = 'next' | 'prev'
type PagerAction = PageDirection | 'refresh'

export function HistoryPage() {
  const [activeGame, setActiveGame] = useState<LotteryHistoryGameType>('pl5')
  const meta = GAME_META[activeGame]
  const positionLabels = POSITION_LABELS.slice(0, meta.mainCount)
  const [state, setState] = useState<HistoryState>(initialState)
  const [pageDirection, setPageDirection] = useState<PageDirection>('next')
  const [pendingAction, setPendingAction] = useState<PagerAction | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const lastPageRef = useRef(1)
  // 请求令牌：只让最后一次请求落地。切彩种不再被上一轮请求挡住
  const requestTokenRef = useRef(0)
  const loadedGameRef = useRef<LotteryHistoryGameType | null>(null)

  // 分析结果由服务端在开奖后算好并带溯源；这里不再下载全量开奖、也不再跑 Worker
  const predictionSnapshot = useAnalysisSnapshot(activeGame, 'prediction', 2, {
    enabled: meta.positional,
  })
  const dltSnapshot = useAnalysisSnapshot('dlt', 'dlt', undefined, { enabled: !meta.positional })

  const prediction = predictionSnapshot.snapshot?.analysis ?? EMPTY_PREDICTION
  const predictionLoading = meta.positional && predictionSnapshot.loading

  const loadHistory = useCallback(
    async (pageNo = 1, action: PagerAction = 'next') => {
      const token = requestTokenRef.current + 1
      requestTokenRef.current = token
      const game = activeGame
      const isGameSwitch = loadedGameRef.current !== game
      loadedGameRef.current = game

      const startedAt = Date.now()
      setPendingAction(action)

      if (isGameSwitch) {
        // 切彩种：先清空列表，让骨架屏按新彩种铺开，避免短暂显示上一个彩种的数据
        lastPageRef.current = 1
        contentRef.current?.scrollTo({ top: 0 })
        setState({ ...initialState, loading: true })
      } else {
        setState((prev) => ({ ...prev, loading: true, error: '' }))
      }

      try {
        const data = await historyService.getHistoryPage(game, pageNo)

        // 本地缓存命中时数据几乎立刻返回，这里补足一个最短 loading 时长，
        // 让按钮转圈"看得见"，而不是闪一帧就消失。
        await waitAtLeast(startedAt, HISTORY_MIN_BUSY_MS)
        if (requestTokenRef.current !== token) {
          return
        }

        // 翻页时先把滚动位置归零，再让新内容滑入，避免停在上一页的底部
        if (data.pageNo !== lastPageRef.current) {
          lastPageRef.current = data.pageNo
          contentRef.current?.scrollTo({ top: 0 })
        }

        setPageDirection(action === 'prev' ? 'prev' : 'next')
        setState({
          loading: false,
          error: '',
          items: data.list,
          pageNo: data.pageNo,
          total: data.total,
          pages: data.pages,
        })
      } catch {
        await waitAtLeast(startedAt, HISTORY_MIN_BUSY_MS)
        if (requestTokenRef.current !== token) {
          return
        }
        setState((prev) => ({
          ...prev,
          loading: false,
          error: '开奖历史加载失败，请稍后重试',
        }))
      } finally {
        if (requestTokenRef.current === token) {
          setPendingAction(null)
        }
      }
    },
    [activeGame],
  )

  useEffect(() => {
    void loadHistory(1)
  }, [loadHistory])

  const pageSummary = useMemo(() => {
    const pageText =
      state.total > 0
        ? `当前第 ${state.pageNo} / ${state.pages} 页`
        : `第 ${state.pageNo} / ${state.pages} 页`
    return {
      totalText: state.total > 0 ? `共 ${state.total} 期，` : '',
      pageText,
    }
  }, [state.pageNo, state.pages, state.total])
  const trendRows = useMemo(
    () =>
      state.items.map((item) => ({
        item,
        digits: positionLabels.map((_, position) => parseDigitValue(item, position)),
      })),
    // positionLabels 由 activeGame 决定
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.items, activeGame],
  )
  const trendPredictions = useMemo(
    () => prediction.positions.map((item) => item.picks),
    [prediction.positions],
  )

  const isInitialLoading =
    (state.loading && state.items.length === 0) ||
    (state.items.length > 0 && meta.positional && predictionLoading)
  const pageAnimClass = pageDirection === 'prev' ? 'is-prev-page' : 'is-next-page'

  // 点击即进入 busy：只在按钮上转圈，内容保持原样，避免整块明暗变化被感知成闪烁
  const busyAction = pendingAction

  return (
    <section className="history-page">
      <header className="history-page__header">
        <div>
          <p className="history-page__eyebrow">开奖历史</p>
          <h2>体彩开奖查询</h2>
        </div>
        <p className="history-page__desc">
          排列五、七星彩按位次看走势；大乐透结合前后区矩阵与逐期指标，按全量历史数据给出下期号码参考和理由；数据来自体彩官方接口。
        </p>
      </header>

      <div className="history-page__toolbar">
        <nav className="history-page__tabs" aria-label="开奖彩种切换">
          {historyTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={tab.key === activeGame ? 'is-active' : ''}
              onClick={() => setActiveGame(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div className="history-page__summary">
          <span>
            {pageSummary.totalText}
            {pageSummary.pageText}
          </span>
          <button
            type="button"
            disabled={state.loading}
            onClick={() => void loadHistory(state.pageNo, 'refresh')}
          >
            刷新
          </button>
        </div>
      </div>

      <div ref={contentRef} className="history-page__content" aria-busy={state.loading || predictionLoading}>
        {isInitialLoading && !state.error && <HistoryPageSkeleton game={activeGame} />}

        {!state.loading && state.error && (
          <div className="history-page__status history-page__status--error">
            <span>{state.error}</span>
            <button type="button" onClick={() => void loadHistory(state.pageNo, 'refresh')}>
              重新加载
            </button>
          </div>
        )}

        {!isInitialLoading && !state.error && (
          <>
            {meta.positional && (
            <section className="history-insight">
              <div className="history-insight__header">
                <div>
                  <p className="history-insight__eyebrow">全量数据预测</p>
                  <h3>基于全量 {prediction.sampleSize} 期开奖数据</h3>
                </div>
                <p className="history-insight__desc">
                  综合频次分布、近期热度、遗漏值、相邻转移关系评分，并用滚动回测验证参考效果。
                </p>
              </div>

              <div className="history-insight__metrics">
                <article className="history-insight__metric">
                  <span>平均 Top1 命中</span>
                  <strong>{formatRate(prediction.averageTop1Rate)}</strong>
                </article>
                <article className="history-insight__metric">
                  <span>平均 Top3 命中</span>
                  <strong>{formatRate(prediction.averageTop3Rate)}</strong>
                </article>
                <article className="history-insight__metric">
                  <span>回测样本</span>
                  <strong>{formatBacktestSamples(prediction.positions)}</strong>
                </article>
              </div>

              <div className="history-insight__numbers">
                <span className="history-insight__numbers-label">组合参考</span>
                <div className="history-insight__numbers-list">
                  {prediction.combinations.length > 0 ? (
                    prediction.combinations.map((item) => (
                      <span key={item.value} className="history-insight__number-pill">
                        {item.value}
                      </span>
                    ))
                  ) : (
                    <span className="history-insight__number-empty">样本不足，暂不生成组合参考</span>
                  )}
                </div>
              </div>
            </section>
            )}

            {!meta.positional && <DltRecommendationPanel recommendation={dltSnapshot.snapshot?.analysis ?? null} />}

            <div
              key={`desktop-${activeGame}-${state.pageNo}`}
              className={`history-page__desktop ${pageAnimClass}${meta.positional ? '' : ' is-dlt'}`}
              style={{
                gridTemplateColumns: meta.positional
                  ? `5.1rem repeat(${meta.mainCount}, minmax(0, 1fr))`
                  : '5.1rem minmax(0, 35fr) minmax(0, 12fr) 12.8rem',
              }}
            >
              <section className="trend-axis">
                <div className="trend-axis__spacer" aria-hidden="true" />
                <div className="trend-axis__header">期号 / 日期</div>
                {!meta.positional && (
                  <div className="trend-axis__stats">
                    <span>出现次数</span>
                    <span>当前遗漏</span>
                  </div>
                )}
                <div className="trend-axis__body">
                  {trendRows.map((row) => (
                    <div key={`desktop-meta-${row.item.issue}`} className="trend-axis__row">
                      <strong>{row.item.issue}</strong>
                      <span>{row.item.drawDate}</span>
                    </div>
                  ))}
                </div>
              </section>

              {meta.positional
                ? positionLabels.map((label, position) => {
                    const special = meta.specialLast && position === positionLabels.length - 1
                    return (
                      <TrendPanel
                        key={`${activeGame}-${label}`}
                        label={label}
                        axis={DIGIT_AXIS}
                        rows={state.items}
                        series={[
                          {
                            key: 'digit',
                            label,
                            color: special ? '#2563eb' : '#ea580c',
                            tone: 'front' as const,
                            values: trendRows.map((row) => row.digits[position]),
                          },
                        ]}
                        badge={special ? '后一位' : undefined}
                        caption={formatPositionCaption(prediction.positions[position])}
                        forecast={formatPredictionText(trendPredictions[position])}
                      />
                    )
                  })
                : (
                    <>
                      {[
                        {
                          key: 'front',
                          label: '前区',
                          axis: FRONT_AXIS,
                          caption: '前区 1–35 选 5',
                          series: FRONT_COLORS.map((color, index) => ({
                            key: `front-${index}`,
                            label: `第 ${index + 1} 球`,
                            color,
                            tone: 'front' as const,
                            values: state.items.map((item) => toBallValue(item.numbers[index])),
                          })),
                        },
                        {
                          key: 'back',
                          label: '后区',
                          axis: BACK_AXIS,
                          caption: '后区 1–12 选 2',
                          series: BACK_COLORS.map((color, index) => ({
                            key: `back-${index}`,
                            label: `第 ${index + 1} 球`,
                            color,
                            tone: 'back' as const,
                            values: state.items.map((item) =>
                              toBallValue(item.numbers[meta.mainCount + index]),
                            ),
                          })),
                        },
                      ].map((panel) => (
                        <TrendPanel
                          key={`${activeGame}-${panel.key}`}
                          label={panel.label}
                          axis={panel.axis}
                          rows={state.items}
                          series={panel.series}
                          caption={panel.caption}
                          showLines={false}
                          showStats
                        />
                      ))}
                      <DltIndicatorRail rows={state.items} />
                    </>
                  )}
            </div>

            <div
              key={`mobile-${activeGame}-${state.pageNo}`}
              className={`history-page__mobile ${pageAnimClass}`}
            >
              <ul className="history-page__list">
                {state.items.map((item) => {
                  const indicators = meta.positional ? null : getDltFrontIndicators(item.numbers)
                  return (
                    <li key={item.issue} className="history-card">
                      <div className="history-card__head">
                        <div>
                          <span className="history-card__issue-label">第 {item.issue} 期</span>
                          <strong>{item.drawDate}</strong>
                        </div>
                        <span className="history-card__game-tag">{meta.label}</span>
                      </div>

                      <div className="history-card__numbers" aria-label={`第${item.issue}期开奖号码`}>
                        {item.numbers.map((num, index) => {
                          const isExtra = index >= meta.mainCount
                          const isSpecial = meta.specialLast && index === meta.mainCount - 1
                          return (
                            <span
                              key={`${item.issue}-${index}-${num}`}
                              className={`history-card__ball${isExtra ? ' is-extra' : ''}${
                                isSpecial ? ' is-special' : ''
                              }`}
                            >
                              {num}
                            </span>
                          )
                        })}
                      </div>

                      {indicators && (
                        <div className="history-card__indicators" aria-label="前区逐期指标">
                          <span className="history-card__indicator">
                            <span className="history-card__indicator-label">和值</span>
                            <strong>{indicators.sum}</strong>
                          </span>
                          <span className="history-card__indicator">
                            <span className="history-card__indicator-label">跨度</span>
                            <strong>{indicators.span}</strong>
                          </span>
                          <span className="history-card__indicator">
                            <span className="history-card__indicator-label">奇偶</span>
                            <strong>{formatDltOddEven(indicators)}</strong>
                          </span>
                          <span className="history-card__indicator">
                            <span className="history-card__indicator-label">大小</span>
                            <strong>{formatDltBigSmall(indicators)}</strong>
                          </span>
                          <span className="history-card__indicator">
                            <span className="history-card__indicator-label">三区</span>
                            <strong>{formatDltZones(indicators)}</strong>
                          </span>
                        </div>
                      )}

                      <div className="history-card__meta">
                        <div className="history-card__meta-item">
                          <span>销售额</span>
                          <strong>{item.salesAmount}</strong>
                        </div>
                        <div className="history-card__meta-item">
                          <span>一等奖注数</span>
                          <strong>{item.firstPrizeCount}</strong>
                        </div>
                        <div className="history-card__meta-item">
                          <span>一等奖奖金</span>
                          <strong>{item.firstPrizeAmount}</strong>
                        </div>
                        <div className="history-card__meta-item">
                          <span>奖池</span>
                          <strong>{item.poolAmount}</strong>
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          </>
        )}
      </div>

      {!state.error && !isInitialLoading && (state.items.length > 0 || !state.loading) && (
        <div className={`history-page__pager${busyAction ? ' is-busy' : ''}`}>
          <button
            type="button"
            className={busyAction === 'prev' ? 'is-loading' : undefined}
            disabled={state.loading || state.pageNo <= 1}
            aria-busy={busyAction === 'prev'}
            onClick={() => void loadHistory(state.pageNo - 1, 'prev')}
          >
            <span className="history-page__pager-label">上一页</span>
            {busyAction === 'prev' && <span className="history-page__pager-spinner" aria-hidden="true" />}
          </button>
          <span className="history-page__pager-summary">
            {pageSummary.totalText && (
              <span className="history-page__pager-total">{pageSummary.totalText}</span>
            )}
            {pageSummary.pageText}
          </span>
          <button
            type="button"
            className={busyAction === 'next' ? 'is-loading' : undefined}
            disabled={state.loading || state.pageNo >= state.pages}
            aria-busy={busyAction === 'next'}
            onClick={() => void loadHistory(state.pageNo + 1, 'next')}
          >
            <span className="history-page__pager-label">下一页</span>
            {busyAction === 'next' && <span className="history-page__pager-spinner" aria-hidden="true" />}
          </button>
        </div>
      )}
    </section>
  )
}

type TrendSeries = {
  key: string
  label: string
  color: string
  tone: 'front' | 'back'
  values: Array<number | null>
}

type TrendPanelProps = {
  label: string
  /** 横轴取值范围：排列五/七星彩是 0–9，大乐透前区 1–35、后区 1–12 */
  axis: number[]
  rows: LotteryHistoryEntry[]
  series: TrendSeries[]
  caption: string
  forecast?: string
  badge?: string
  showLegend?: boolean
  /** 是否把落点连成折线：位次彩种连线，大乐透按业界习惯只标命中 */
  showLines?: boolean
  /** 底部追加「出现次数 / 当前遗漏」两行统计 */
  showStats?: boolean
}

const TrendPanel = memo(function TrendPanel({
  label,
  axis,
  rows,
  series,
  caption,
  forecast,
  badge,
  showLegend = false,
  showLines = true,
  showStats = false,
}: TrendPanelProps) {
  return (
    <section
      className={`trend-panel${badge ? ' is-special' : ''}${axis.length > 12 ? ' is-wide' : ''}`}
    >
      <div className="trend-panel__header">
        <div>
          <div className="trend-panel__eyebrow-row">
            <span className="trend-panel__eyebrow">号码走势</span>
            {forecast && <span className="trend-panel__forecast">参考 {forecast}</span>}
          </div>
          <h3>
            {label}
            {badge && <em className="trend-panel__badge">{badge}</em>}
          </h3>
        </div>
        <span className="trend-panel__caption">{caption}</span>
      </div>

      {showLegend && (
        <div className="trend-panel__legend">
          {series.map((item) => (
            <span key={item.key}>
              <i style={{ background: item.color }} />
              {item.label}
            </span>
          ))}
        </div>
      )}

      <TrendGrid
        label={label}
        axis={axis}
        rows={rows}
        series={series}
        showLines={showLines}
        showStats={showStats}
      />
    </section>
  )
})

/**
 * 走势表格只依赖当期开奖行，不依赖预测结果。
 * 预测在 Worker 返回后会触发页面更新，但这里可以跳过单元格的重建。
 */
const TrendGrid = memo(function TrendGrid({
  label,
  axis,
  rows,
  series,
  showLines = true,
  showStats = false,
}: {
  label: string
  axis: number[]
  rows: LotteryHistoryEntry[]
  series: TrendSeries[]
  showLines?: boolean
  showStats?: boolean
}) {
  const lines = series.map((item) => ({
    ...item,
    points: item.values.flatMap((value, rowIndex) => {
      if (value === null) {
        return []
      }
      const axisIndex = axis.indexOf(value)
      return axisIndex < 0 ? [] : [{ rowIndex, axisIndex }]
    }),
  }))

  // 业界通用的大乐透走势会带两行数字统计：出现次数、当前遗漏
  const statsRows = showStats
    ? (() => {
        const counts = new Map<number, number>()
        const gaps = new Map<number, number>()

        for (const value of axis) {
          let count = 0
          let gap = rows.length
          for (let index = 0; index < rows.length; index += 1) {
            const hit = series.some((item) => item.values[index] === value)
            if (hit) {
              count += 1
              if (gap === rows.length) {
                gap = index
              }
            }
          }
          counts.set(value, count)
          gaps.set(value, gap)
        }

        const hotThreshold = Math.max(2, Math.round(rows.length / axis.length) + 1)

        return [
          {
            key: 'count',
            title: `近 ${rows.length} 期出现次数`,
            values: counts,
            hot: (value: number) => (counts.get(value) ?? 0) >= hotThreshold,
          },
          {
            key: 'gap',
            title: '当前遗漏（多少期没出）',
            values: gaps,
            hot: (value: number) => gaps.get(value) === 0,
          },
        ]
      })()
    : []

  return (
    <div className="trend-panel__table">
      <div className="trend-panel__table-head">
        <div className="trend-panel__digits-head">
          {axis.map((value) => (
            <span key={`${label}-head-${value}`}>{value}</span>
          ))}
        </div>
      </div>

      <div className="trend-panel__table-body">
        <div
          className="trend-panel__grid-wrap"
          style={
            {
              '--trend-row-count': rows.length,
            } as CSSProperties
          }
        >
          {showLines && (
            <>
              <svg
                className="trend-panel__lines"
                viewBox={`0 0 ${axis.length} ${Math.max(rows.length, 1)}`}
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                {lines.map((line) => (
                  <path
                    key={line.key}
                    d={buildSmoothPath(line.points, axis.length)}
                    stroke={line.color}
                    className="trend-panel__polyline"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </svg>

              <div className="trend-panel__dots" aria-hidden="true">
                {lines.flatMap((line) =>
                  line.points.map((point) => (
                    <span
                      key={`${label}-${line.key}-${point.rowIndex}`}
                      style={{
                        left: `${((point.axisIndex + 0.5) / axis.length) * 100}%`,
                        top: `calc(${point.rowIndex + 0.5} * 1.875rem)`,
                        borderColor: line.color,
                      }}
                    />
                  )),
                )}
              </div>
            </>
          )}

          <div className="trend-panel__grid">
            {/* 统计行放最上面，滚动前就能看到出现次数与当前遗漏 */}
            {showStats &&
              statsRows.map((stat) => (
                <div
                  key={`${label}-stat-${stat.key}`}
                  className="trend-panel__grid-row is-stat"
                  title={stat.title}
                >
                  {axis.map((value) => (
                    <span
                      key={`${label}-stat-${stat.key}-${value}`}
                      className={`trend-panel__cell is-stat${stat.hot(value) ? ' is-hot' : ''}`}
                    >
                      {stat.values.get(value) ?? 0}
                    </span>
                  ))}
                </div>
              ))}

            {rows.map((row, rowIndex) => (
              <div key={`${label}-${row.issue}-row`} className="trend-panel__grid-row">
                {axis.map((value) => {
                  const hits = series.filter((item) => item.values[rowIndex] === value)
                  const back = hits.some((item) => item.tone === 'back')
                  return (
                    <span
                      key={`${label}-${row.issue}-${value}`}
                      className={`trend-panel__cell${hits.length > 0 ? ' is-hit' : ''}${
                        hits.length > 0 && back ? ' is-back' : ''
                      }`}
                    >
                      {value}
                    </span>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
})

function parseDigitValue(item: LotteryHistoryEntry, position: number) {
  const value = item.numbers[position]
  if (!value || !/^\d$/.test(value)) {
    return null
  }
  return Number(value)
}

/** "01" / "35" → 1 / 35；非法值返回 null */
function toBallValue(value: string | undefined) {
  if (!value) {
    return null
  }
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : null
}

/**
 * 平滑折线：Catmull-Rom 转三次贝塞尔。
 * 坐标用「列 / 行」为单位，由 viewBox 拉伸到实际尺寸。
 */
function buildSmoothPath(points: Array<{ rowIndex: number; axisIndex: number }>, axisLength: number) {
  if (points.length === 0) {
    return ''
  }

  const samples = points.map((point) => ({ x: point.axisIndex + 0.5, y: point.rowIndex + 0.5 }))
  if (samples.length === 1) {
    return `M ${samples[0].x} ${samples[0].y}`
  }

  const clampX = (value: number) => Math.min(axisLength, Math.max(0, value))
  let path = `M ${samples[0].x.toFixed(3)} ${samples[0].y.toFixed(3)}`

  for (let index = 0; index < samples.length - 1; index += 1) {
    const previous = samples[index - 1] ?? samples[index]
    const current = samples[index]
    const next = samples[index + 1]
    const after = samples[index + 2] ?? samples[index + 1]

    const control1x = clampX(current.x + (next.x - previous.x) / 6)
    const control1y = current.y + (next.y - previous.y) / 6
    const control2x = clampX(next.x - (after.x - current.x) / 6)
    const control2y = next.y - (after.y - current.y) / 6

    path += ` C ${control1x.toFixed(3)} ${control1y.toFixed(3)} ${control2x.toFixed(3)} ${control2y.toFixed(3)} ${next.x.toFixed(3)} ${next.y.toFixed(3)}`
  }

  return path
}

function formatRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return '--'
  }
  return `${(value * 100).toFixed(1)}%`
}

function formatBacktestSamples(positions: Array<{ backtest: { samples: number } }>) {
  const sampleCount = positions[0]?.backtest.samples ?? 0
  return sampleCount > 0 ? `${sampleCount} 期` : '--'
}

function formatPositionCaption(positionAnalysis: { backtest: { top1Rate: number; top3Rate: number; samples: number } } | undefined) {
  if (!positionAnalysis || positionAnalysis.backtest.samples <= 0) {
    return '本地样本不足，暂不输出回测结果'
  }
  return `回测 Top1 ${formatRate(positionAnalysis.backtest.top1Rate)}，Top3 ${formatRate(positionAnalysis.backtest.top3Rate)}`
}

function formatPredictionText(digits: number[] | undefined) {
  return digits && digits.length > 0 ? digits.join(' / ') : '--'
}
