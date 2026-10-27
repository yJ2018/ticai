import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  DEFAULT_PREDICTION_SCORE_WEIGHTS,
  analyzeHistoryPrediction,
  type HistoryPredictionAnalysis,
  type PredictionDigitStat,
  type PredictionDistributionBucket,
  type PredictionMarkovPositionAnalysis,
  type PredictionPositionAnalysis,
  type PredictionScoreWeights,
} from '../domain/historyPrediction'
import { useAnalysisSnapshot } from '../features/analysis/useAnalysisSnapshot'
import { usePredictionTuning } from '../features/analysis/usePredictionTuning'
import { MarkovOrderSelect } from '../components/MarkovOrderSelect'
import { AnalysisPageSkeleton, AnalysisSummarySkeleton } from '../components/AnalysisPageSkeleton'

/**
 * 分析页：默认直接渲染服务端快照（同一期只算一次，含溯源）。
 *
 * 权重滑块是连续值，服务端预算不了，所以只有「用户真的拖了权重」时才切到本地：
 * 一次取回全量号码（紧凑接口，约 45 KB gzip），在 Worker 里按当前权重重算。
 * 一旦把权重拖回默认值，就自动退回服务端快照。
 */

const EMPTY_ANALYSIS: HistoryPredictionAnalysis = analyzeHistoryPrediction([], {
  scoreWeights: DEFAULT_PREDICTION_SCORE_WEIGHTS,
  markovOrder: 2,
})

const MARKOV_ORDER_OPTIONS = [1, 2, 3, 4, 5] as const

const SCORE_WEIGHT_FIELDS: Array<{
  key: keyof PredictionScoreWeights
  label: string
  description: string
}> = [
  { key: 'recent', label: '近期频次', description: '最近窗口里越热的数字，得分越高。' },
  { key: 'long', label: '长期频次', description: '拉长样本后更稳定的高频数字，会被适度加分。' },
  { key: 'omission', label: '遗漏值', description: '长时间未出的数字，会得到一定补偿分。' },
  { key: 'transition', label: '单步转移', description: '参考上一期后面最常接出的数字。' },
  { key: 'pairTransition', label: '双步转移', description: '参考最近两期组合后面最常接出的数字。' },
]

export function HistoryAnalysisPage() {
  const [scoreWeights, setScoreWeights] = useState<PredictionScoreWeights>(DEFAULT_PREDICTION_SCORE_WEIGHTS)
  const [markovOrder, setMarkovOrder] = useState(2)
  const [activePosition, setActivePosition] = useState(0)

  const debouncedScoreWeights = useDebouncedValue(scoreWeights, 160)
  const isCustomWeights = !areScoreWeightsEqual(debouncedScoreWeights, DEFAULT_PREDICTION_SCORE_WEIGHTS)

  // 马尔可夫阶数 1–5 都在开奖时预算好了，换档只是换一个快照
  const { loading: snapshotLoading, error: snapshotError, snapshot, reload } = useAnalysisSnapshot(
    'pl5',
    'prediction',
    markovOrder,
  )

  const tuning = usePredictionTuning({
    enabled: isCustomWeights,
    order: markovOrder,
    weights: debouncedScoreWeights,
  })

  const analysis = useMemo(() => {
    if (isCustomWeights && tuning.analysis) {
      return tuning.analysis
    }
    return snapshot?.analysis ?? EMPTY_ANALYSIS
  }, [isCustomWeights, snapshot, tuning.analysis])

  const loading = isCustomWeights ? tuning.loading : snapshotLoading
  const error = isCustomWeights ? tuning.error : snapshotError
  const sample = isCustomWeights ? null : snapshot?.sample
  const activePositionAnalysis =
    analysis.positions[Math.min(activePosition, Math.max(analysis.positions.length - 1, 0))]
  const isAnalysisPending =
    !areScoreWeightsEqual(scoreWeights, debouncedScoreWeights) || (!loading && isCustomWeights && tuning.loading)

  return (
    <section className="history-analysis-page">
      <header className="history-analysis-page__header">
        <div>
          <p className="history-analysis-page__eyebrow">算法分析页</p>
          <h2>全量历史数据怎么得出预测</h2>
        </div>
        <p className="history-analysis-page__desc">
          这页不只显示结果，而是展开每一位号码的评分依据、最近样本和滚动回测结果。
        </p>
      </header>

      <div className="history-analysis-page__toolbar">
        <div className="history-analysis-page__summary">
          {loading ? (
            <AnalysisSummarySkeleton count={3} />
          ) : (
            <>
              <span>样本 {analysis.sampleSize} 期</span>
              <span>平均 Top1 {formatRate(analysis.averageTop1Rate)}</span>
              <span>平均 Top3 {formatRate(analysis.averageTop3Rate)}</span>
              {sample && <span>基准 {sample.throughIssue} · {sample.throughDrawDate}</span>}
              {isCustomWeights && <span>自定义权重 · 本地重算</span>}
              {!isCustomWeights && snapshot?.stale && (
                <span className="history-analysis-page__pending">有新开奖，待重算</span>
              )}
            </>
          )}
        </div>
        <div className="history-analysis-page__actions">
          {isAnalysisPending && !loading && (
            <span className="history-analysis-page__pending">正在重新计算...</span>
          )}
          <MarkovOrderSelect
            value={markovOrder}
            options={MARKOV_ORDER_OPTIONS}
            onChange={setMarkovOrder}
          />
          <button type="button" onClick={() => setScoreWeights(DEFAULT_PREDICTION_SCORE_WEIGHTS)}>
            重置权重
          </button>
          <button type="button" onClick={reload}>
            刷新分析
          </button>
        </div>
      </div>

      {loading && <AnalysisPageSkeleton variant="history" />}

      {!loading && error && (
        <div className="history-analysis-page__status history-analysis-page__status--error">
          <span>{error}</span>
          <button type="button" onClick={reload}>
            重新加载
          </button>
        </div>
      )}

      {!loading && !error && (
        <>
          <section className="prediction-hero prediction-hero--classic">
            <div className="prediction-hero__main">
              <div>
                <p className="prediction-hero__eyebrow">本期重点预测</p>
                <h3>{analysis.combinations[0]?.value ?? '--'}</h3>
              </div>
              <div className="prediction-hero__metrics">
                <span>主推分数 {formatCandidateScore(analysis.combinations[0]?.score)}</span>
                <span>平均 Top1 {formatRate(analysis.averageTop1Rate)}</span>
                <span>平均 Top3 {formatRate(analysis.averageTop3Rate)}</span>
              </div>
            </div>

            <div className="prediction-hero__grid">
              {analysis.positions.map((positionAnalysis) => (
                <article key={`hero-position-${positionAnalysis.position}`} className="prediction-hero__card">
                  <p>{getPositionLabel(positionAnalysis.position)}</p>
                  <strong>{formatDigits(positionAnalysis.picks)}</strong>
                  <span>
                    最新 {formatDigit(positionAnalysis.latestDigit)} / Top1 {formatRate(positionAnalysis.backtest.top1Rate)}
                  </span>
                </article>
              ))}
            </div>

            <div className="prediction-hero__secondary">
              <span className="prediction-hero__secondary-label">更多组合</span>
              <div className="prediction-hero__secondary-list">
                {analysis.combinations.length > 0 ? (
                  analysis.combinations.slice(0, 5).map((item) => (
                    <span key={`hero-combination-${item.value}`}>
                      {item.value} / {item.score.toFixed(1)}
                    </span>
                  ))
                ) : (
                  <span>样本不足，暂不输出组合参考</span>
                )}
              </div>
            </div>
          </section>

          <section className="analysis-controls">
            <div className="analysis-controls__header">
              <div>
                <p className="analysis-controls__eyebrow">权重调参</p>
                <h3>拖动滑块，实时观察推荐与回测变化</h3>
              </div>
              <p className="analysis-controls__desc">
                所有权重会自动归一化，下面显示的是当前实际生效占比。
              </p>
            </div>

            <div className="analysis-controls__grid">
              {SCORE_WEIGHT_FIELDS.map((field) => (
                <article key={field.key} className="analysis-control-card">
                  <div className="analysis-control-card__top">
                    <div>
                      <strong>{field.label}</strong>
                      <span>{field.description}</span>
                    </div>
                    <div className="analysis-control-card__meta">
                      <span>输入 {Math.round(scoreWeights[field.key] * 100)}%</span>
                      <strong>生效 {formatWeight(analysis.config.scoreWeights[field.key])}</strong>
                    </div>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={Math.round(scoreWeights[field.key] * 100)}
                    onChange={(event) => {
                      const nextValue = Number(event.target.value)
                      setScoreWeights((prev) => ({
                        ...prev,
                        [field.key]: nextValue / 100,
                      }))
                    }}
                  />
                </article>
              ))}
            </div>
          </section>

          <section className="analysis-overview">
            <article className="analysis-overview__panel">
              <p className="analysis-overview__title">当前参数</p>
              <div className="analysis-overview__facts">
                <span>近期频次 {formatWeight(analysis.config.scoreWeights.recent)}</span>
                <span>长期频次 {formatWeight(analysis.config.scoreWeights.long)}</span>
                <span>遗漏值 {formatWeight(analysis.config.scoreWeights.omission)}</span>
                <span>单步转移 {formatWeight(analysis.config.scoreWeights.transition)}</span>
                <span>双步转移 {formatWeight(analysis.config.scoreWeights.pairTransition)}</span>
                <span>近期窗口 {analysis.config.recentWindow} 期</span>
                <span>长期窗口 {analysis.config.longWindow} 期</span>
                <span>最小训练样本 {analysis.config.minTrainingSize} 期</span>
                <span>组合池 {analysis.config.combinationPoolSize} 位候选</span>
                <span>组合输出 {analysis.config.combinationLimit} 注</span>
                <span>马尔科夫阶数 {analysis.config.markovOrder} 阶</span>
              </div>
            </article>

            <article className="analysis-overview__panel">
              <p className="analysis-overview__title">组合参考</p>
              <div className="analysis-overview__chips">
                {analysis.combinations.length > 0 ? (
                  analysis.combinations.map((item) => (
                    <span key={item.value}>
                      {item.value} / {item.score.toFixed(1)}
                    </span>
                  ))
                ) : (
                  <span>样本不足，暂不输出组合参考</span>
                )}
              </div>
            </article>

            <article className="analysis-overview__panel">
              <p className="analysis-overview__title">回测概览</p>
              <div className="analysis-overview__facts">
                <span>平均 Top1 {formatRate(analysis.averageTop1Rate)}</span>
                <span>平均 Top3 {formatRate(analysis.averageTop3Rate)}</span>
                <span>马尔科夫 Top1 {formatRate(analysis.markov.averageTop1Rate)}</span>
                <span>马尔科夫 Top3 {formatRate(analysis.markov.averageTop3Rate)}</span>
                <span>使用样本 {analysis.sampleSize} 期</span>
              </div>
            </article>
          </section>

          <section className="analysis-overview">
            <article className="analysis-overview__panel">
              <p className="analysis-overview__title">马尔科夫链分析</p>
              <div className="analysis-overview__facts">
                <span>当前阶数 {analysis.markov.order} 阶</span>
                <span>平均 Top1 {formatRate(analysis.markov.averageTop1Rate)}</span>
                <span>平均 Top3 {formatRate(analysis.markov.averageTop3Rate)}</span>
              </div>
              <div className="analysis-overview__chips">
                {analysis.markov.combinations.length > 0 ? (
                  analysis.markov.combinations.map((item) => (
                    <span key={`markov-combination-${item.value}`}>
                      {item.value} / {item.score.toFixed(1)}
                    </span>
                  ))
                ) : (
                  <span>当前状态样本不足，暂不输出马尔科夫组合参考</span>
                )}
              </div>
            </article>
          </section>

          <section className="analysis-stat-grid">
            <article className="analysis-stat-card">
              <div className="analysis-stat-card__header">
                <div>
                  <p className="analysis-stat-card__eyebrow">冷热号分布</p>
                  <h3>最近 {analysis.statistics.hotCold.recentWindow} 期对比近 {analysis.statistics.hotCold.longWindow} 期</h3>
                </div>
              </div>

              <div className="analysis-stat-card__dual">
                <div className="analysis-stat-card__list">
                  <strong>热号</strong>
                  {analysis.statistics.hotCold.hotDigits.map((item) => (
                    <DigitStatRow
                      key={`hot-${item.digit}`}
                      item={item}
                      tone="hot"
                      recentWindow={analysis.statistics.hotCold.recentWindow}
                      longWindow={analysis.statistics.hotCold.longWindow}
                    />
                  ))}
                </div>
                <div className="analysis-stat-card__list">
                  <strong>冷号</strong>
                  {analysis.statistics.hotCold.coldDigits.map((item) => (
                    <DigitStatRow
                      key={`cold-${item.digit}`}
                      item={item}
                      tone="cold"
                      recentWindow={analysis.statistics.hotCold.recentWindow}
                      longWindow={analysis.statistics.hotCold.longWindow}
                    />
                  ))}
                </div>
              </div>
            </article>

            <article className="analysis-stat-card">
              <div className="analysis-stat-card__header">
                <div>
                  <p className="analysis-stat-card__eyebrow">和值 / 跨度</p>
                  <h3>最近窗口的和值均值与跨度分布</h3>
                </div>
              </div>

              <div className="analysis-stat-card__facts">
                <span>和值均值 {formatDecimal(analysis.statistics.sumSpan.recentAverageSum)}</span>
                <span>跨度均值 {formatDecimal(analysis.statistics.sumSpan.recentAverageSpan)}</span>
              </div>

              <div className="analysis-stat-card__dual">
                <div className="analysis-stat-card__list">
                  <strong>高频和值</strong>
                  {analysis.statistics.sumSpan.topSums.map((bucket) => (
                    <BucketRow key={`sum-${bucket.label}`} bucket={bucket} />
                  ))}
                </div>
                <div className="analysis-stat-card__list">
                  <strong>高频跨度</strong>
                  {analysis.statistics.sumSpan.topSpans.map((bucket) => (
                    <BucketRow key={`span-${bucket.label}`} bucket={bucket} />
                  ))}
                </div>
              </div>
            </article>

            <article className="analysis-stat-card">
              <div className="analysis-stat-card__header">
                <div>
                  <p className="analysis-stat-card__eyebrow">单双 / 大小</p>
                  <h3>最近 {analysis.config.recentWindow} 期整体结构占比</h3>
                </div>
              </div>

              <div className="analysis-stat-card__meters">
                <RateMeter label="奇数" value={analysis.statistics.paritySize.oddRate} color="orange" />
                <RateMeter label="偶数" value={analysis.statistics.paritySize.evenRate} color="blue" />
                <RateMeter label="大数" value={analysis.statistics.paritySize.bigRate} color="purple" />
                <RateMeter label="小数" value={analysis.statistics.paritySize.smallRate} color="green" />
              </div>

              <div className="analysis-stat-card__dual">
                <div className="analysis-stat-card__list">
                  <strong>常见单双比</strong>
                  {analysis.statistics.paritySize.oddEvenPatterns.map((bucket) => (
                    <BucketRow key={`odd-even-${bucket.label}`} bucket={bucket} suffix="奇:偶" />
                  ))}
                </div>
                <div className="analysis-stat-card__list">
                  <strong>常见大小比</strong>
                  {analysis.statistics.paritySize.bigSmallPatterns.map((bucket) => (
                    <BucketRow key={`big-small-${bucket.label}`} bucket={bucket} suffix="大:小" />
                  ))}
                </div>
              </div>
            </article>
          </section>

          <section className="analysis-method">
            <h3>分析流程</h3>
            <ol className="analysis-method__list">
              <li>先按期号升序整理本地缓存历史，保证每一位都按真实开奖时间线计算。</li>
              <li>对 0-9 每个数字分别统计近期出现次数、长期出现次数、当前遗漏期数。</li>
              <li>基于最近 1 期和最近 2 期的数字组合，统计历史上下一期最常接出的数字。</li>
              <li>按当前滑块权重计算综合得分，取每位分数最高的前 3 个数字作为参考。</li>
              <li>用滚动回测验证：只用过去数据预测下一期，累计统计 Top1 和 Top3 命中率。</li>
            </ol>
          </section>

          <section className="analysis-positions">
            <div className="analysis-positions__header">
              <div>
                <p className="analysis-positions__eyebrow">分位分析</p>
                <h3>按位置切换查看，减少整页信息堆叠</h3>
              </div>
              <div className="analysis-position-tabs" role="tablist" aria-label="号码位置切换">
                {analysis.positions.map((positionAnalysis) => (
                  <button
                    key={`position-tab-${positionAnalysis.position}`}
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
                    <span>样本 {activePositionAnalysis.historySample} 期</span>
                    <span>Top1 {formatRate(activePositionAnalysis.backtest.top1Rate)}</span>
                    <span>Top3 {formatRate(activePositionAnalysis.backtest.top3Rate)}</span>
                  </div>
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

                <div className="analysis-position-card__recent">
                  <span className="analysis-position-card__recent-label">马尔科夫链</span>
                  <div className="analysis-overview__facts">
                    <span>目标阶数 {activePositionAnalysis.markov.order} 阶</span>
                    <span>实际命中 {formatMarkovOrder(activePositionAnalysis.markov.effectiveOrder)}</span>
                    <span>状态 {formatMarkovPattern(activePositionAnalysis.markov.sourcePattern)}</span>
                    <span>样本命中 {activePositionAnalysis.markov.supportCount} 次</span>
                    <span>Top1 {formatRate(activePositionAnalysis.markov.backtest.top1Rate)}</span>
                    <span>Top3 {formatRate(activePositionAnalysis.markov.backtest.top3Rate)}</span>
                  </div>
                  <div className="analysis-overview__chips">
                    {activePositionAnalysis.markov.candidates.length > 0 ? (
                      activePositionAnalysis.markov.candidates.map((candidate) => (
                        <span key={`markov-${activePositionAnalysis.position}-${candidate.digit}`}>
                          {candidate.digit} / {formatRate(candidate.probability)} / {candidate.count} 次
                        </span>
                      ))
                    ) : (
                      <span>暂无可用状态转移样本</span>
                    )}
                  </div>
                </div>

                <div className="analysis-position-card__table-wrap">
                  <table className="analysis-position-card__table">
                    <thead>
                      <tr>
                        <th>数字</th>
                        <th>总分</th>
                        <th>近期</th>
                        <th>长期</th>
                        <th>遗漏</th>
                        <th>单转移</th>
                        <th>双转移</th>
                        <th>近 {analysis.config.recentWindow} 期</th>
                        <th>近 {analysis.config.longWindow} 期</th>
                        <th>遗漏期数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activePositionAnalysis.candidates.map((candidate) => (
                        <tr key={`${activePositionAnalysis.position}-${candidate.digit}`}>
                          <td>{candidate.digit}</td>
                          <td>{candidate.score.toFixed(1)}</td>
                          <td>{candidate.breakdown.recent.toFixed(1)}</td>
                          <td>{candidate.breakdown.long.toFixed(1)}</td>
                          <td>{candidate.breakdown.omission.toFixed(1)}</td>
                          <td>{candidate.breakdown.transition.toFixed(1)}</td>
                          <td>{candidate.breakdown.pairTransition.toFixed(1)}</td>
                          <td>{candidate.recentCount}</td>
                          <td>{candidate.totalCount}</td>
                          <td>{candidate.missSpan}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <p className="analysis-position-card__footnote">
                  {formatBacktestText(activePositionAnalysis)} {formatMarkovBacktestText(activePositionAnalysis.markov)}
                </p>
              </article>
            )}
          </section>
        </>
      )}
    </section>
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

function formatWeight(value: number) {
  return `${Math.round(value * 100)}%`
}

function formatCandidateScore(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '--'
}

function formatDigits(digits: number[]) {
  return digits.length > 0 ? digits.join(' / ') : '--'
}

function formatDigit(value: number | null) {
  return value === null ? '--' : String(value)
}

function formatBacktestText(positionAnalysis: PredictionPositionAnalysis) {
  if (positionAnalysis.backtest.samples <= 0) {
    return '本位有效样本不足，暂时无法生成滚动回测结果。'
  }

  return `滚动回测 ${positionAnalysis.backtest.samples} 期，Top1 命中 ${positionAnalysis.backtest.top1Hits} 次，Top3 命中 ${positionAnalysis.backtest.top3Hits} 次。`
}

function formatMarkovBacktestText(positionAnalysis: PredictionMarkovPositionAnalysis) {
  if (positionAnalysis.backtest.samples <= 0) {
    return '马尔科夫链样本不足，暂时无法生成独立回测结果。'
  }

  return `马尔科夫链滚动回测 ${positionAnalysis.backtest.samples} 期，Top1 命中 ${positionAnalysis.backtest.top1Hits} 次，Top3 命中 ${positionAnalysis.backtest.top3Hits} 次。`
}

function formatDecimal(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return '--'
  }
  return value.toFixed(1)
}

function formatMarkovPattern(pattern: number[]) {
  return pattern.length > 0 ? pattern.join(' -> ') : '退化为全局频次'
}

function formatMarkovOrder(value: number) {
  return value > 0 ? `${value} 阶` : '0 阶回退'
}

function DigitStatRow({
  item,
  tone,
  recentWindow,
  longWindow,
}: {
  item: PredictionDigitStat
  tone: 'hot' | 'cold'
  recentWindow: number
  longWindow: number
}) {
  return (
    <div className={`analysis-stat-row analysis-stat-row--${tone}`}>
      <span className="analysis-stat-row__digit">{item.digit}</span>
      <div className="analysis-stat-row__body">
        <strong>
          近 {recentWindow} 期 {item.recentCount} 次 / 近 {longWindow} 期 {item.longCount} 次
        </strong>
        <span>当前遗漏 {item.missSpan} 期</span>
      </div>
    </div>
  )
}

function BucketRow({ bucket, suffix }: { bucket: PredictionDistributionBucket; suffix?: string }) {
  return (
    <div className="analysis-bucket-row">
      <div>
        <strong>
          {suffix ? `${bucket.label} ${suffix}` : bucket.label}
        </strong>
        <span>
          出现 {bucket.count} 次 / 占比 {formatRate(bucket.rate)}
        </span>
      </div>
    </div>
  )
}

function RateMeter({ label, value, color }: { label: string; value: number; color: 'orange' | 'blue' | 'purple' | 'green' }) {
  return (
    <div className={`analysis-meter analysis-meter--${color}`}>
      <div className="analysis-meter__head">
        <span>{label}</span>
        <strong>{formatRate(value)}</strong>
      </div>
      <div className="analysis-meter__track">
        <span
          className="analysis-meter__fill"
          style={
            {
              '--analysis-meter-width': `${Math.max(0, Math.min(value * 100, 100))}%`,
            } as CSSProperties
          }
        />
      </div>
    </div>
  )
}

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value)

  useEffect(() => {
    const timerId = window.setTimeout(() => {
      setDebouncedValue(value)
    }, delayMs)

    return () => {
      window.clearTimeout(timerId)
    }
  }, [delayMs, value])

  return debouncedValue
}

function areScoreWeightsEqual(left: PredictionScoreWeights, right: PredictionScoreWeights) {
  return (
    left.recent === right.recent &&
    left.long === right.long &&
    left.omission === right.omission &&
    left.transition === right.transition &&
    left.pairTransition === right.pairTransition
  )
}
