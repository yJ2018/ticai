import { useCallback, useEffect, useRef, useState } from 'react'
import {
  analyzeMathTrendPrediction,
  type MathTrendPositionAnalysis,
  type MathTrendPredictionAnalysis,
} from '../domain/historyPrediction'
import { historyService, type LotteryHistoryEntry, type LotteryHistoryGameType } from '../service/historyService'
import { AnalysisPageSkeleton, AnalysisSummarySkeleton } from '../components/AnalysisPageSkeleton'

type AnalysisState = {
  loading: boolean
  error: string
  analysisItems: LotteryHistoryEntry[]
}

const LARGE_SAMPLE_PAGE_SIZE = 300

const initialState: AnalysisState = {
  loading: true,
  error: '',
  analysisItems: [],
}

export function MathTrendAnalysisPage() {
  const [activeGame] = useState<LotteryHistoryGameType>('pl5')
  const [state, setState] = useState<AnalysisState>(initialState)
  const [activePosition, setActivePosition] = useState(0)
  const [analysis, setAnalysis] = useState<MathTrendPredictionAnalysis>(() => analyzeMathTrendPrediction([]))
  const [isWorkerComputing, setIsWorkerComputing] = useState(false)
  const workerRef = useRef<Worker | null>(null)
  const requestIdRef = useRef(0)

  const loadAnalysisData = useCallback(async () => {
    setState((prev) => ({
      ...prev,
      loading: true,
      error: '',
    }))

    try {
      await historyService.getHistoryPage(activeGame, 1, LARGE_SAMPLE_PAGE_SIZE)
      const cachedItems = await historyService.getCachedHistoryEntries(activeGame)

      setState({
        loading: false,
        error: '',
        analysisItems: cachedItems,
      })
    } catch {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: '数学分析数据加载失败，请稍后重试',
      }))
    }
  }, [activeGame])

  useEffect(() => {
    void loadAnalysisData()
  }, [loadAnalysisData])

  useEffect(() => {
    const worker = new Worker(new URL('../workers/mathTrendAnalysisWorker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker

    worker.onmessage = (
      event: MessageEvent<{
        requestId: number
        analysis: MathTrendPredictionAnalysis
      }>,
    ) => {
      if (event.data.requestId !== requestIdRef.current) {
        return
      }

      setAnalysis(event.data.analysis)
      setIsWorkerComputing(false)
    }

    worker.onerror = () => {
      setIsWorkerComputing(false)
    }

    return () => {
      workerRef.current = null
      worker.terminate()
    }
  }, [])

  useEffect(() => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setIsWorkerComputing(true)

    const currentWorker = workerRef.current
    if (!currentWorker) {
      setAnalysis(analyzeMathTrendPrediction(state.analysisItems))
      setIsWorkerComputing(false)
      return
    }

    currentWorker.postMessage({
      requestId,
      entries: state.analysisItems,
      options: {},
    })
  }, [state.analysisItems])

  const activePositionAnalysis = analysis.positions[Math.min(activePosition, Math.max(analysis.positions.length - 1, 0))]
  const validationSamples = analysis.positions[0]?.backtest.samples ?? 0

  return (
    <section className="history-analysis-page math-trend-page">
      <header className="history-analysis-page__header">
        <div>
          <p className="history-analysis-page__eyebrow">数学走势页</p>
          <h2>只从分布与折线趋势推下一位</h2>
        </div>
        <p className="history-analysis-page__desc">
          保留原有权重算法不动，这一页单独用大样本分布、折线外推、周期间隔和动量变化来给出下一期候选。
        </p>
      </header>

      <div className="history-analysis-page__toolbar">
        <div className="history-analysis-page__summary">
          {state.loading ? (
            <AnalysisSummarySkeleton count={5} />
          ) : (
            <>
              <span>本地样本 {analysis.sampleSize} 期</span>
              <span>分析窗口 {analysis.effectiveSampleWindow} 期</span>
              <span>滚动验证 {validationSamples} 期</span>
              <span>平均 Top1 {formatRate(analysis.averageTop1Rate)}</span>
              <span>平均 Top3 {formatRate(analysis.averageTop3Rate)}</span>
            </>
          )}
        </div>
        <div className="history-analysis-page__actions">
          {isWorkerComputing && !state.loading && (
            <span className="history-analysis-page__pending">正在重算大样本走势...</span>
          )}
          <button type="button" onClick={() => void loadAnalysisData()}>
            刷新分析
          </button>
        </div>
      </div>

      {state.loading && <AnalysisPageSkeleton variant="math" />}

      {!state.loading && state.error && (
        <div className="history-analysis-page__status history-analysis-page__status--error">
          <span>{state.error}</span>
          <button type="button" onClick={() => void loadAnalysisData()}>
            重新加载
          </button>
        </div>
      )}

      {!state.loading && !state.error && (
        <>
          <section className="prediction-hero prediction-hero--math">
            <div className="prediction-hero__main">
              <div>
                <p className="prediction-hero__eyebrow">本期重点预测</p>
                <h3>{buildMainMathPrediction(analysis.positions)}</h3>
              </div>
              <div className="prediction-hero__metrics">
                <span>滚动验证 {validationSamples} 期</span>
                <span>平均 Top1 {formatRate(analysis.averageTop1Rate)}</span>
                <span>平均 Top3 {formatRate(analysis.averageTop3Rate)}</span>
              </div>
            </div>

            <div className="prediction-hero__grid">
              {analysis.positions.map((positionAnalysis) => (
                <article key={`math-hero-position-${positionAnalysis.position}`} className="prediction-hero__card">
                  <p>{getPositionLabel(positionAnalysis.position)}</p>
                  <strong>{formatDigits(positionAnalysis.picks)}</strong>
                  <span>
                    中心 {formatCenter(positionAnalysis.predictedCenter)} / Top1 {formatRate(positionAnalysis.backtest.top1Rate)}
                  </span>
                </article>
              ))}
            </div>
          </section>

          <section className="analysis-overview">
            <article className="analysis-overview__panel">
              <p className="analysis-overview__title">模型参数</p>
              <div className="analysis-overview__facts">
                <span>样本窗口 {analysis.config.sampleWindow} 期</span>
                <span>趋势窗口 {analysis.config.trendWindow} 期</span>
                <span>验证起点 {analysis.config.validationStart} 期</span>
                <span>每位候选 {analysis.config.candidateCount} 个</span>
              </div>
            </article>

            <article className="analysis-overview__panel">
              <p className="analysis-overview__title">数学视角</p>
              <div className="math-trend-page__pill-list">
                <span>分布回归</span>
                <span>折线外推</span>
                <span>平均间隔</span>
                <span>短中期动量</span>
              </div>
            </article>

            <article className="analysis-overview__panel">
              <p className="analysis-overview__title">结果解读</p>
              <div className="analysis-overview__facts">
                <span>Top1 看最准单点</span>
                <span>Top3 看候选覆盖</span>
                <span>折线中心越近，趋势分越高</span>
                <span>当前间隔接近历史均隔，周期分越高</span>
              </div>
            </article>
          </section>

          <section className="math-trend-page__principles">
            <article className="math-trend-page__principle-card">
              <p>1</p>
              <strong>先取更大的历史样本</strong>
              <span>默认优先拿最近 240 期做分析，让分布规律更稳定，不被短期抖动带偏。</span>
            </article>
            <article className="math-trend-page__principle-card">
              <p>2</p>
              <strong>再看折线走势中心</strong>
              <span>对最近 36 期数字序列做加权均值和线性斜率，外推下一期更可能落在哪个数值区间。</span>
            </article>
            <article className="math-trend-page__principle-card">
              <p>3</p>
              <strong>同时校验周期与动量</strong>
              <span>观察每个数字的平均间隔和短中期热度变化，避免只盯一条线。</span>
            </article>
            <article className="math-trend-page__principle-card">
              <p>4</p>
              <strong>最后做大样本回测</strong>
              <span>只用过去数据滚动预测下一期，累计统计 Top1 与 Top3 命中率。</span>
            </article>
          </section>

          <section className="analysis-positions">
            <div className="analysis-positions__header">
              <div>
                <p className="analysis-positions__eyebrow">分位走势</p>
                <h3>按位置查看折线走势和分布候选</h3>
              </div>
              <div className="analysis-position-tabs" role="tablist" aria-label="数学走势位置切换">
                {analysis.positions.map((positionAnalysis) => (
                  <button
                    key={`math-position-tab-${positionAnalysis.position}`}
                    type="button"
                    role="tab"
                    aria-selected={activePosition === positionAnalysis.position}
                    className={activePosition === positionAnalysis.position ? 'is-active' : ''}
                    onClick={() => setActivePosition(positionAnalysis.position)}
                  >
                    {getPositionLabel(positionAnalysis.position)}
                  </button>
                ))}
              </div>
            </div>

            {activePositionAnalysis && (
              <article className="analysis-position-card">
                <div className="analysis-position-card__header">
                  <div>
                    <p className="analysis-position-card__eyebrow">{getPositionLabel(activePositionAnalysis.position)}</p>
                    <h3>推荐 {formatDigits(activePositionAnalysis.picks)}</h3>
                  </div>
                  <div className="analysis-position-card__stats">
                    <span>最新号码 {formatDigit(activePositionAnalysis.latestDigit)}</span>
                    <span>样本 {activePositionAnalysis.sampleWindow} 期</span>
                    <span>中心 {formatCenter(activePositionAnalysis.predictedCenter)}</span>
                    <span>斜率 {formatSigned(activePositionAnalysis.trendSlope)}</span>
                    <span>波动 {formatValue(activePositionAnalysis.volatility)}</span>
                    <span>Top1 {formatRate(activePositionAnalysis.backtest.top1Rate)}</span>
                    <span>Top3 {formatRate(activePositionAnalysis.backtest.top3Rate)}</span>
                  </div>
                </div>

                <div className="math-trend-page__chart-panel">
                  <div className="math-trend-page__chart-copy">
                    <strong>折线走势预估</strong>
                    <span>
                      最近均值 {formatValue(activePositionAnalysis.recentAverage)}，外推中心 {formatCenter(activePositionAnalysis.predictedCenter)}。
                    </span>
                  </div>
                  <TrendMiniChart
                    digits={[...activePositionAnalysis.recentDigits].reverse()}
                    predictedCenter={activePositionAnalysis.predictedCenter}
                  />
                </div>

                <div className="analysis-position-card__recent">
                  <span className="analysis-position-card__recent-label">最近样本</span>
                  <div className="analysis-position-card__recent-list">
                    {activePositionAnalysis.recentDigits.length > 0 ? (
                      activePositionAnalysis.recentDigits.map((digit, index) => (
                        <span key={`${activePositionAnalysis.position}-${index}-${digit}`}>{digit}</span>
                      ))
                    ) : (
                      <span>暂无有效样本</span>
                    )}
                  </div>
                </div>

                <div className="analysis-position-card__table-wrap">
                  <table className="analysis-position-card__table math-trend-page__table">
                    <thead>
                      <tr>
                        <th>数字</th>
                        <th>总分</th>
                        <th>分布</th>
                        <th>趋势</th>
                        <th>周期</th>
                        <th>动量</th>
                        <th>偏离中心</th>
                        <th>分布差值</th>
                        <th>当前间隔</th>
                        <th>平均间隔</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activePositionAnalysis.candidates.map((candidate) => (
                        <tr key={`${activePositionAnalysis.position}-${candidate.digit}`}>
                          <td>{candidate.digit}</td>
                          <td>{candidate.score.toFixed(1)}</td>
                          <td>{candidate.breakdown.distribution.toFixed(1)}</td>
                          <td>{candidate.breakdown.trend.toFixed(1)}</td>
                          <td>{candidate.breakdown.cycle.toFixed(1)}</td>
                          <td>{candidate.breakdown.momentum.toFixed(1)}</td>
                          <td>{candidate.predictedDistance.toFixed(1)}</td>
                          <td>{formatSigned(candidate.distributionGap)}</td>
                          <td>{candidate.currentGap}</td>
                          <td>{candidate.averageGap.toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <p className="analysis-position-card__footnote">{formatBacktestText(activePositionAnalysis)}</p>
              </article>
            )}
          </section>
        </>
      )}
    </section>
  )
}

function TrendMiniChart({ digits, predictedCenter }: { digits: number[]; predictedCenter: number | null }) {
  if (digits.length === 0) {
    return <div className="math-trend-page__chart-empty">暂无折线样本</div>
  }

  const width = 320
  const height = 88
  const pointCount = Math.max(digits.length - 1, 1)
  const points = digits
    .map((digit, index) => {
      const x = (index / pointCount) * width
      const y = height - (digit / 9) * height
      return `${x},${y}`
    })
    .join(' ')

  const lastX = width
  const lastY = height - (digits[digits.length - 1] / 9) * height
  const forecastX = width + 26
  const forecastY = predictedCenter === null ? lastY : height - (predictedCenter / 9) * height

  return (
    <div className="math-trend-page__chart">
      <svg viewBox={`0 0 ${width + 36} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <polyline points={points} className="math-trend-page__chart-line" />
        <line
          x1={lastX}
          y1={lastY}
          x2={forecastX}
          y2={forecastY}
          className="math-trend-page__chart-dash"
        />
        <circle cx={lastX} cy={lastY} r="4.5" className="math-trend-page__chart-dot" />
        {predictedCenter !== null && <circle cx={forecastX} cy={forecastY} r="4.5" className="math-trend-page__chart-forecast" />}
      </svg>
      <div className="math-trend-page__chart-axis">
        <span>旧</span>
        <span>新</span>
        <span>预测</span>
      </div>
    </div>
  )
}

function getPositionLabel(position: number) {
  return ['第一位', '第二位', '第三位', '第四位', '第五位'][position] ?? `第 ${position + 1} 位`
}

function formatRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return '--'
  }
  return `${(value * 100).toFixed(1)}%`
}

function formatDigits(digits: number[]) {
  return digits.length > 0 ? digits.join(' / ') : '--'
}

function formatDigit(value: number | null) {
  return value === null ? '--' : String(value)
}

function formatCenter(value: number | null) {
  return value === null ? '--' : value.toFixed(1)
}

function formatValue(value: number) {
  if (!Number.isFinite(value) && value !== 0) {
    return '--'
  }
  return value.toFixed(1)
}

function formatSigned(value: number) {
  if (!Number.isFinite(value) && value !== 0) {
    return '--'
  }
  const normalized = value.toFixed(1)
  return value > 0 ? `+${normalized}` : normalized
}

function formatBacktestText(positionAnalysis: MathTrendPositionAnalysis) {
  if (positionAnalysis.backtest.samples <= 0) {
    return '本位有效样本仍然不足，暂时无法生成大样本滚动验证结果。'
  }

  return `滚动验证 ${positionAnalysis.backtest.samples} 期，Top1 命中 ${positionAnalysis.backtest.top1Hits} 次，Top3 命中 ${positionAnalysis.backtest.top3Hits} 次。`
}

function buildMainMathPrediction(positions: MathTrendPredictionAnalysis['positions']) {
  const topDigits = positions.map((position) => position.picks[0]).filter((digit): digit is number => Number.isFinite(digit))
  return topDigits.length > 0 ? topDigits.join('') : '--'
}
