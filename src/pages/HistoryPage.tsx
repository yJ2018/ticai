import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import {
  analyzeHistoryPrediction,
  type HistoryPredictionAnalysis,
} from '../domain/historyPrediction'
import { historyService, type LotteryHistoryEntry, type LotteryHistoryGameType } from '../service/historyService'
import { HistoryPageSkeleton } from '../components/HistoryPageSkeleton'

const historyTabs: Array<{ key: LotteryHistoryGameType; label: string }> = [{ key: 'pl5', label: '排列五' }]
const TREND_DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
const TREND_POSITIONS = ['第一位', '第二位', '第三位', '第四位', '第五位']
const TREND_CELL_SIZE = 30
const TREND_ROW_SIZE = 34
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
  analysisItems: LotteryHistoryEntry[]
  pageNo: number
  total: number
  pages: number
}

const initialState: HistoryState = {
  loading: true,
  error: '',
  items: [],
  analysisItems: [],
  pageNo: 1,
  total: 0,
  pages: 1,
}

type PageDirection = 'next' | 'prev'
type PagerAction = PageDirection | 'refresh'

export function HistoryPage() {
  const [activeGame, setActiveGame] = useState<LotteryHistoryGameType>('pl5')
  const [state, setState] = useState<HistoryState>(initialState)
  const [pageDirection, setPageDirection] = useState<PageDirection>('next')
  const [pendingAction, setPendingAction] = useState<PagerAction | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const lastPageRef = useRef(1)
  // 同步锁：state 更新到 DOM 之间有窗口期，用 ref 挡住同一帧内的重复触发
  const busyRef = useRef(false)

  const [prediction, setPrediction] = useState<HistoryPredictionAnalysis>(() =>
    analyzeHistoryPrediction([]),
  )
  const [predictionLoading, setPredictionLoading] = useState(false)
  const [predictionReady, setPredictionReady] = useState(false)
  const predictionWorkerRef = useRef<Worker | null>(null)
  const predictionRequestRef = useRef(0)
  const lastPredictionSignatureRef = useRef('')

  const loadHistory = useCallback(
    async (pageNo = 1, action: PagerAction = 'next') => {
      if (busyRef.current) {
        return
      }
      busyRef.current = true

      const startedAt = Date.now()
      setPendingAction(action)
      setState((prev) => ({
        ...prev,
        loading: true,
        error: '',
      }))

      try {
        const data = await historyService.getHistoryPage(activeGame, pageNo)
        const cachedItems = await historyService.getCachedHistoryEntries(activeGame)

        // 本地缓存命中时数据几乎立刻返回，这里补足一个最短 loading 时长，
        // 让按钮转圈"看得见"，而不是闪一帧就消失。
        await waitAtLeast(startedAt, HISTORY_MIN_BUSY_MS)

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
          analysisItems: cachedItems.length > 0 ? cachedItems : data.list,
          pageNo: data.pageNo,
          total: data.total,
          pages: data.pages,
        })
      } catch {
        await waitAtLeast(startedAt, HISTORY_MIN_BUSY_MS)
        setState((prev) => ({
          ...prev,
          loading: false,
          error: '开奖历史加载失败，请稍后重试',
        }))
      } finally {
        busyRef.current = false
        setPendingAction(null)
      }
    },
    [activeGame],
  )

  useEffect(() => {
    void loadHistory(1)
  }, [loadHistory])

  // 7755 期样本的预测会阻塞主线程，这里和另两个分析页一样下沉到 Worker。
  useEffect(() => {
    const worker = new Worker(
      new URL('../workers/historyAnalysisWorker.ts', import.meta.url),
      { type: 'module' },
    )
    predictionWorkerRef.current = worker

    worker.onmessage = (
      event: MessageEvent<{
        requestId: number
        analysis: HistoryPredictionAnalysis
      }>,
    ) => {
      if (event.data.requestId !== predictionRequestRef.current) {
        return
      }
      startTransition(() => {
        setPrediction(event.data.analysis)
        setPredictionReady(true)
        setPredictionLoading(false)
      })
    }

    worker.onerror = () => {
      setPredictionReady(true)
      setPredictionLoading(false)
    }

    return () => {
      worker.terminate()
      predictionWorkerRef.current = null
    }
  }, [])

  const analysisEntries =
    state.analysisItems.length > 0 ? state.analysisItems : state.items
  const predictionSignature =
    analysisEntries.length > 0
      ? `${analysisEntries.length}:${analysisEntries[0]?.issue ?? ''}:${
          analysisEntries[analysisEntries.length - 1]?.issue ?? ''
        }`
      : ''

  useEffect(() => {
    if (!predictionSignature || predictionSignature === lastPredictionSignatureRef.current) {
      return
    }
    lastPredictionSignatureRef.current = predictionSignature
    const requestId = predictionRequestRef.current + 1
    predictionRequestRef.current = requestId
    setPredictionLoading(true)

    const worker = predictionWorkerRef.current
    if (!worker) {
      startTransition(() => {
        setPrediction(analyzeHistoryPrediction(analysisEntries))
        setPredictionReady(true)
        setPredictionLoading(false)
      })
      return
    }

    worker.postMessage({
      requestId,
      entries: analysisEntries,
      options: {},
    })
    // entries 只在这个签名变化时更新，避免翻页时对同一份缓存重复重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [predictionSignature])

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
        digits: TREND_POSITIONS.map((_, position) => parseDigitValue(item, position)),
      })),
    [state.items],
  )
  const trendPredictions = useMemo(
    () => prediction.positions.map((item) => item.picks),
    [prediction.positions],
  )

  const isInitialLoading =
    (state.loading && state.items.length === 0) ||
    (state.items.length > 0 && !predictionReady)
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
        <p className="history-page__desc">首版优先接入排列五开奖历史，后续可以继续扩展更多彩种。</p>
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
        {isInitialLoading && !state.error && <HistoryPageSkeleton />}

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
            <section className="history-insight">
              <div className="history-insight__header">
                <div>
                  <p className="history-insight__eyebrow">本地数据预测</p>
                  <h3>基于本地已缓存 {prediction.sampleSize} 期历史数据</h3>
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
                    <span className="history-insight__number-empty">本地缓存样本不足，暂不生成组合参考</span>
                  )}
                </div>
              </div>
            </section>

            <div
              key={`desktop-${state.pageNo}`}
              className={`history-page__desktop ${pageAnimClass}`}
            >
              <section className="trend-axis">
                <div className="trend-axis__spacer" aria-hidden="true" />
                <div className="trend-axis__header">期号 / 日期</div>
                <div className="trend-axis__body">
                  {trendRows.map((row) => (
                    <div key={`desktop-meta-${row.item.issue}`} className="trend-axis__row">
                      <strong>{row.item.issue}</strong>
                      <span>{row.item.drawDate}</span>
                    </div>
                  ))}
                </div>
              </section>

              {TREND_POSITIONS.map((label, position) => (
                <TrendPanel
                  key={label}
                  label={label}
                  position={position}
                  rows={trendRows}
                  caption={formatPositionCaption(prediction.positions[position])}
                  forecast={formatPredictionText(trendPredictions[position])}
                />
              ))}
            </div>

            <div
              key={`mobile-${state.pageNo}`}
              className={`history-page__mobile ${pageAnimClass}`}
            >
              <ul className="history-page__list">
                {state.items.map((item) => (
                  <li key={item.issue} className="history-card">
                    <div className="history-card__head">
                      <div>
                        <span className="history-card__issue-label">第 {item.issue} 期</span>
                        <strong>{item.drawDate}</strong>
                      </div>
                      <span className="history-card__game-tag">排列五</span>
                    </div>

                    <div className="history-card__numbers" aria-label={`第${item.issue}期开奖号码`}>
                      {item.numbers.map((num, index) => (
                        <span key={`${item.issue}-${index}-${num}`} className="history-card__ball">
                          {num}
                        </span>
                      ))}
                    </div>

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
                ))}
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

type TrendRow = {
  item: LotteryHistoryEntry
  digits: Array<number | null>
}

type TrendPanelProps = {
  label: string
  position: number
  rows: TrendRow[]
  caption: string
  forecast: string
}

const TrendPanel = memo(function TrendPanel({
  label,
  position,
  rows,
  caption,
  forecast,
}: TrendPanelProps) {
  return (
    <section className="trend-panel">
      <div className="trend-panel__header">
        <div>
          <div className="trend-panel__eyebrow-row">
            <span className="trend-panel__eyebrow">号码走势</span>
            <span className="trend-panel__forecast">参考 {forecast}</span>
          </div>
          <h3>{label}</h3>
        </div>
        <span className="trend-panel__caption">{caption}</span>
      </div>
      <TrendGrid label={label} position={position} rows={rows} />
    </section>
  )
})

/**
 * 走势表格只依赖当期开奖行，不依赖预测结果。
 * 预测在 Worker 返回后会触发页面更新，但这里可以跳过 5×30×10 个单元格的重建。
 */
const TrendGrid = memo(function TrendGrid({
  label,
  position,
  rows,
}: {
  label: string
  position: number
  rows: TrendRow[]
}) {
  return (
    <div className="trend-panel__table">
      <div className="trend-panel__table-head">
        <div className="trend-panel__digits-head">
          {TREND_DIGITS.map((digit) => (
            <span key={`${label}-head-${digit}`}>{digit}</span>
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
          <svg
            className="trend-panel__lines"
            viewBox={`0 0 ${TREND_DIGITS.length * TREND_CELL_SIZE} ${Math.max(rows.length * TREND_ROW_SIZE, TREND_ROW_SIZE)}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polyline points={buildTrendPoints(rows, position)} className="trend-panel__polyline" />
            {rows.map((row, rowIndex) => {
              const digit = row.digits[position]
              if (digit === null) {
                return null
              }

              return (
                <circle
                  key={`${label}-${row.item.issue}-dot`}
                  cx={digit * TREND_CELL_SIZE + TREND_CELL_SIZE / 2}
                  cy={rowIndex * TREND_ROW_SIZE + TREND_ROW_SIZE / 2}
                  r={5}
                  className="trend-panel__line-dot"
                />
              )
            })}
          </svg>

          <div className="trend-panel__grid">
            {rows.map((row) => (
              <div key={`${label}-${row.item.issue}-row`} className="trend-panel__grid-row">
                {TREND_DIGITS.map((digit) => {
                  const active = row.digits[position] === digit
                  return (
                    <span
                      key={`${label}-${row.item.issue}-${digit}`}
                      className={`trend-panel__cell ${active ? 'is-hit' : ''}`}
                    >
                      {digit}
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

function buildTrendPoints(
  rows: Array<{ item: LotteryHistoryEntry; digits: Array<number | null> }>,
  position: number,
) {
  return rows
    .map((row, rowIndex) => {
      const digit = row.digits[position]
      if (digit === null) {
        return ''
      }
      const x = digit * TREND_CELL_SIZE + TREND_CELL_SIZE / 2
      const y = rowIndex * TREND_ROW_SIZE + TREND_ROW_SIZE / 2
      return `${x},${y}`
    })
    .filter(Boolean)
    .join(' ')
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

function formatPredictionText(digits: number[]) {
  return digits.length > 0 ? digits.join(' / ') : '--'
}
