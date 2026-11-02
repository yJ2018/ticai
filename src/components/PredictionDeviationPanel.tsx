import { useMemo } from 'react'

import type {
  PredictionTrackDigitStat,
  PredictionTrackSummary,
  PredictionTrackWindow,
} from '../domain/predictionTrack'

/**
 * 命中归档 + 偏差分析。
 *
 * 只消费服务端算好的 summary，不在浏览器里重算：
 *   - 分位命中：每位 Top1/Top3 实际命中率 vs 随机基线；
 *   - 号码偏差：选中占比 − 实际占比（正数 = 模型高估了这个数字）；
 *   - 漂移：最近 30/100/300/1000 期与全量的差；
 *   - 组合：6 注参考里 5 位全中的次数、平均对上几位。
 *
 * 这里的文案必须诚实：排列五是独立随机开奖，命中率贴着基线是正常结果，
 * 不把 ±1pp 的噪声说成「规律」。
 */

type PredictionDeviationPanelProps = {
  gameLabel: string
  positionLabels: string[]
  summary: PredictionTrackSummary | null
  loading: boolean
  error: string
}

const ROLLING_WINDOW = 60
const RATE_SCALE = 0.42

export function PredictionDeviationPanel({
  gameLabel,
  positionLabels,
  summary,
  loading,
  error,
}: PredictionDeviationPanelProps) {
  const notes = useMemo(
    () => (summary ? buildNotes(summary, positionLabels) : []),
    [summary, positionLabels],
  )

  return (
    <section className="deviation" aria-label="命中归档与偏差分析">
      <header className="deviation__header">
        <div>
          <p className="deviation__eyebrow">逐期归档 · 偏差分析</p>
          <h3>{gameLabel}每一期参考的命中与偏差</h3>
        </div>
        <p className="deviation__desc">
          每期只用开奖前的数据生成参考，开奖后逐位核对；选中占比 − 实际占比 = 偏差，
          正数代表模型高估了这个号码。
        </p>
      </header>

      {!summary && loading && (
        <div className="deviation__status">
          <span className="deviation__spinner" aria-hidden="true" />
          正在载入逐期归档…
        </div>
      )}

      {!summary && !loading && error && (
        <div className="deviation__status deviation__status--error">
          <span>逐期归档暂时不可用：{error}</span>
          <span>走势图仍可正常查看，命中标记会稍后补齐。</span>
        </div>
      )}

      {!summary && !loading && !error && (
        <div className="deviation__status">
          逐期归档还没生成：该彩种可用样本不足 30 期，或服务端还没执行回填。
        </div>
      )}

      {summary && (
        <>
          <div className="deviation__metrics">
            <MetricCard
              label="全量 Top1"
              value={formatRate(summary.overall.top1Rate)}
              hint={`基线 ${formatRate(summary.baseline.top1)} · ${formatPp(summary.overall.top1Deviation)}`}
              tone={summary.overall.top1Deviation >= 0 ? 'up' : 'down'}
            />
            <MetricCard
              label="全量 Top3"
              value={formatRate(summary.overall.top3Rate)}
              hint={`基线 ${formatRate(summary.baseline.top3)} · ${formatPp(summary.overall.top3Deviation)}`}
              tone={summary.overall.top3Deviation >= 0 ? 'up' : 'down'}
            />
            <MetricCard
              label="近 100 期 Top3"
              value={formatRate(findWindow(summary.windows, 100)?.top3Rate)}
              hint={`较全量 ${formatPp(
                (findWindow(summary.windows, 100)?.top3Rate ?? 0) - summary.overall.top3Rate,
              )}`}
              tone={windowTone(summary)}
            />
            <MetricCard
              label="平均命中名次"
              value={summary.overall.avgRank === null ? '--' : summary.overall.avgRank.toFixed(2)}
              hint={`随机期望 5.50 · ${
                summary.overall.avgRank === null
                  ? '无样本'
                  : `${summary.overall.avgRank < 5.5 ? '领先' : '落后'} ${Math.abs(
                      5.5 - summary.overall.avgRank,
                    ).toFixed(2)}`
              }`}
              tone={summary.overall.avgRank !== null && summary.overall.avgRank < 5.5 ? 'up' : 'down'}
            />
            <MetricCard
              label="组合最好成绩"
              value={`${summary.combinations.best} 位`}
              hint={`${formatCount(summary.combinations.samples)} 注 · 5 位全中 ${formatCount(
                summary.combinations.exactHits,
              )} 次`}
              tone={summary.combinations.best >= 3 ? 'up' : 'flat'}
            />
          </div>

          <div className="deviation__grid">
            <article className="deviation__card">
              <div className="deviation__card-head">
                <h4>分位命中</h4>
                <span>归档 {formatCount(summary.overall.samples)} 期</span>
              </div>
              <div className="deviation__table-wrap">
                <table className="deviation__table">
                  <thead>
                    <tr>
                      <th>位置</th>
                      <th>Top1</th>
                      <th>偏差</th>
                      <th>Top3</th>
                      <th>偏差</th>
                      <th>近 100 期 Top3</th>
                      <th>平均名次</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.positions.map((item) => (
                      <tr key={`deviation-position-${item.position}`}>
                        <th>{labelOf(positionLabels, item.position)}</th>
                        <td>
                          <RateBar rate={item.top1Rate} tone="top1" />
                        </td>
                        <td>
                          <Deviation value={item.top1Deviation} />
                        </td>
                        <td>
                          <RateBar rate={item.top3Rate} tone="top3" />
                        </td>
                        <td>
                          <Deviation value={item.top3Deviation} />
                        </td>
                        <td>
                          <RateBar rate={item.recentTop3Rate} tone="recent" />
                        </td>
                        <td className="deviation__rank">
                          {item.avgRank === null ? '--' : item.avgRank.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="deviation__hint">
                Top1 随机基线 {formatRate(summary.baseline.top1)}，Top3 随机基线{' '}
                {formatRate(summary.baseline.top3)}；平均名次越低越好，随机期望 5.50。
              </p>
            </article>

            <article className="deviation__card">
              <div className="deviation__card-head">
                <h4>命中漂移</h4>
                <span>最近 {Math.min(ROLLING_WINDOW, summary.rolling.length)} 期</span>
              </div>
              <RollingChart rolling={summary.rolling.slice(-ROLLING_WINDOW)} positionCount={summary.positionCount} />
              <div className="deviation__windows">
                {summary.windows.map((item) => (
                  <span key={`window-${item.window}`} className={windowClass(item, summary)}>
                    近 {item.window} 期 T3 {formatRate(item.top3Rate)}
                  </span>
                ))}
              </div>
            </article>
          </div>

          <article className="deviation__card">
            <div className="deviation__card-head">
              <h4>号码偏差矩阵</h4>
              <span>全量 · 选中占比 − 实际占比（pp）</span>
            </div>
            <div className="deviation__matrix-wrap">
              <table className="deviation__matrix">
                <thead>
                  <tr>
                    <th>位置</th>
                    {Array.from({ length: 10 }, (_, digit) => (
                      <th key={`digit-${digit}`}>{digit}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {summary.digits.map((row, position) => (
                    <tr key={`digit-row-${position}`}>
                      <th>{labelOf(positionLabels, position)}</th>
                      {row.map((item) => (
                        <td key={`digit-${position}-${item.digit}`} style={digitCellStyle(item)}>
                          {formatSignedNumber(item.deviation)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="deviation__scale">
              <span>低估</span>
              <i />
              <span>高估</span>
              <em>颜色越深表示偏差越大；整行加起来约为 0。</em>
            </div>
          </article>

          <article className="deviation__card deviation__notes">
            <div className="deviation__card-head">
              <h4>偏差结论</h4>
              <span>
                {summary.sample.fromIssue ?? '--'} → {summary.sample.toIssue ?? '--'}
              </span>
            </div>
            <ul>
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
            <p className="deviation__footnote">
              归档口径：每位取 3 个候选，组合取 6 注；{summary.positionCount > 5 ? '七星彩末位 10–14 记作未命中，因为参考只覆盖 0–9；' : ''}
              开奖是独立随机事件，历史命中率不代表下一期概率，仅供娱乐与复盘。
            </p>
          </article>
        </>
      )}
    </section>
  )
}

function MetricCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint: string
  tone: 'up' | 'down' | 'flat'
}) {
  return (
    <article className={`deviation__metric is-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{hint}</em>
    </article>
  )
}

function RateBar({ rate, tone }: { rate: number; tone: 'top1' | 'top3' | 'recent' }) {
  const width = Math.max(0, Math.min(rate / RATE_SCALE, 1)) * 100
  return (
    <span className={`deviation__rate is-${tone}`}>
      <span>{formatRate(rate)}</span>
      <em>
        <i style={{ width: `${width}%` }} />
      </em>
    </span>
  )
}

function Deviation({ value }: { value: number }) {
  const tone = value > 0.0005 ? 'is-up' : value < -0.0005 ? 'is-down' : 'is-flat'
  return <span className={`deviation__delta ${tone}`}>{formatPp(value, 1)}</span>
}

function RollingChart({
  rolling,
  positionCount,
}: {
  rolling: PredictionTrackSummary['rolling']
  positionCount: number
}) {
  if (rolling.length === 0) {
    return <div className="deviation__empty">暂无逐期命中样本</div>
  }

  const maxHits = Math.max(positionCount, 1)
  // 每位 Top3 的随机命中率是 30%，所以每期随机期望 = 位数 × 0.3
  const baselineHits = positionCount * 0.3
  const movingAverage = rolling.map((_, index) => {
    const start = Math.max(0, index - 9)
    const slice = rolling.slice(start, index + 1)
    return slice.reduce((sum, item) => sum + item.top3, 0) / slice.length
  })
  const points = movingAverage
    .map((value, index) => `${index + 0.5},${maxHits - value}`)
    .join(' ')

  return (
    <div className="deviation__rolling">
      <div className="deviation__rolling-plot">
        <div className="deviation__rolling-bars">
          {rolling.map((item) => (
            <span
              key={`rolling-${item.issue}`}
              className={`deviation__bar${item.top3 >= 3 ? ' is-good' : item.top3 === 2 ? ' is-mid' : ''}`}
              style={{ height: `${Math.max((item.top3 / maxHits) * 100, 2)}%` }}
              title={`第 ${item.issue} 期：Top1 ${item.top1}/${positionCount}，Top3 ${item.top3}/${positionCount}`}
            />
          ))}
        </div>
        <svg
          className="deviation__rolling-line"
          viewBox={`0 0 ${rolling.length} ${maxHits}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <polyline points={points} vectorEffect="non-scaling-stroke" />
        </svg>
        <i
          className="deviation__rolling-base"
          style={{ bottom: `${(baselineHits / maxHits) * 100}%` }}
          title={`随机期望：每期 ${baselineHits.toFixed(1)} 位`}
        />
      </div>
      <div className="deviation__rolling-axis">
        <span>{rolling[0]?.issue}</span>
        <span>每期 Top3 命中位数（虚线 = 随机 {baselineHits.toFixed(1)} 位）</span>
        <span>{rolling[rolling.length - 1]?.issue}</span>
      </div>
    </div>
  )
}

function buildNotes(summary: PredictionTrackSummary, positionLabels: string[]) {
  const notes: string[] = []
  const sorted = [...summary.positions].sort((left, right) => right.top3Rate - left.top3Rate)
  const best = sorted[0]
  const worst = sorted[sorted.length - 1]
  if (best && worst) {
    notes.push(
      `分位：${labelOf(positionLabels, best.position)} Top3 ${formatRate(best.top3Rate)}（${formatPp(
        best.top3Deviation,
      )}）最强，${labelOf(positionLabels, worst.position)} ${formatRate(worst.top3Rate)}（${formatPp(
        worst.top3Deviation,
      )}）最弱，首位差 ${formatPp(best.top3Rate - worst.top3Rate)}。`,
    )
  }

  const flatDigits = summary.digits.flatMap((row, position) =>
    row.map((item) => ({ ...item, position })),
  )
  type PositionedDigit = PredictionTrackDigitStat & { position: number }
  const over = flatDigits.reduce<PositionedDigit | null>(
    (current, item) => (!current || item.deviation > current.deviation ? item : current),
    null,
  )
  const under = flatDigits.reduce<PositionedDigit | null>(
    (current, item) => (!current || item.deviation < current.deviation ? item : current),
    null,
  )
  if (over && under && over.deviation > 0) {
    notes.push(
      `号码：${labelOf(positionLabels, over.position)} 的数字 ${over.digit} 选中占比 ${formatRate(
        over.pickedRate,
      )}、实际占比 ${formatRate(over.actualRate)}，高估 ${formatPp(over.deviation)}；` +
        `数字 ${under.digit} 在${labelOf(positionLabels, under.position)}被低估 ${formatPpAbs(
          under.deviation,
        )}。`,
    )
  }

  const recent100 = findWindow(summary.windows, 100)
  if (recent100 && summary.overall.top3Rate > 0) {
    const drift = recent100.top3Rate - summary.overall.top3Rate
    const direction = Math.abs(drift) < 0.01 ? '基本一致' : drift > 0 ? '偏高' : '偏低'
    notes.push(
      `漂移：近 100 期 Top3 ${formatRate(recent100.top3Rate)}，较全量${direction}（${formatPp(
        drift,
      )}）；100 期样本不大，先当波动看，别据此加注。`,
    )
  }

  const combos = summary.combinations
  notes.push(
    `组合：${formatCount(combos.samples)} 注参考里 5 位全中 ${formatCount(
      combos.exactHits,
    )} 次，最好成绩 ${combos.best} 位，平均对上 ${combos.avgMatched.toFixed(2)} 位。`,
  )

  const top3Dev = summary.overall.top3Deviation
  const rank = summary.overall.avgRank
  if (Math.abs(top3Dev) < 0.01 && (rank === null || Math.abs(rank - 5.5) < 0.05)) {
    notes.push(
      `整体：Top3 ${formatRate(summary.overall.top3Rate)}（${formatPp(top3Dev)}），平均名次 ${
        rank === null ? '--' : rank.toFixed(2)
      }，与随机基线几乎重合——模型目前没有可稳定利用的优势，参考只适合娱乐。`,
    )
  } else {
    notes.push(
      `整体：Top3 ${formatRate(summary.overall.top3Rate)}（${formatPp(top3Dev)}），平均名次 ${
        rank === null ? '--' : rank.toFixed(2)
      }；偏离基线的部分可能来自噪声，继续按周观察是否持续。`,
    )
  }

  return notes
}

function findWindow(windows: PredictionTrackWindow[], window: number) {
  return windows.find((item) => item.window === window)
}

function windowTone(summary: PredictionTrackSummary): 'up' | 'down' | 'flat' {
  const recent = findWindow(summary.windows, 100)
  if (!recent) {
    return 'flat'
  }
  const diff = recent.top3Rate - summary.overall.top3Rate
  return Math.abs(diff) < 0.01 ? 'flat' : diff > 0 ? 'up' : 'down'
}

function windowClass(item: PredictionTrackWindow, summary: PredictionTrackSummary) {
  const diff = item.top3Rate - summary.overall.top3Rate
  return diff > 0.01 ? 'is-up' : diff < -0.01 ? 'is-down' : ''
}

function digitCellStyle(item: PredictionTrackDigitStat) {
  const intensity = Math.min(Math.abs(item.deviation) / 0.08, 1)
  const alpha = 0.08 + intensity * 0.55
  const background =
    item.deviation >= 0 ? `rgba(37, 99, 235, ${alpha.toFixed(2)})` : `rgba(245, 158, 11, ${alpha.toFixed(2)})`
  return {
    background,
    color: intensity > 0.72 ? '#fff' : item.deviation >= 0 ? '#1e3a8a' : '#7c2d12',
  }
}

function labelOf(labels: string[], position: number) {
  return labels[position] ?? `第 ${position + 1} 位`
}

function formatRate(value: number | undefined | null) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--'
  }
  return `${(value * 100).toFixed(1)}%`
}

function formatPp(value: number, digits = 1) {
  if (!Number.isFinite(value)) {
    return '--'
  }
  const normalized = `${value >= 0 ? '+' : ''}${(value * 100).toFixed(digits)}`
  return `${normalized}pp`
}

/** 只用于「被低估 2.1pp」这种已经由文案说明方向的场景，不再带正负号 */
function formatPpAbs(value: number) {
  return `${(Math.abs(value) * 100).toFixed(1)}pp`
}

function formatSignedNumber(value: number) {
  const fixed = (value * 100).toFixed(1)
  return value > 0 ? `+${fixed}` : fixed
}

function formatCount(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}
