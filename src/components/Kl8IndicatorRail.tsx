import { memo, useMemo } from 'react'
import { type LotteryHistoryEntry } from '../domain/lotteryHistory'
import {
  formatAverage,
  formatBigSmall,
  formatOddEven,
  formatZones,
  getKl8Indicators,
  summarizeIndicators,
} from '../domain/welfareIndicators'

type Kl8IndicatorRailProps = {
  rows: LotteryHistoryEntry[]
}

const METRIC_HEADERS = [
  { label: '和值', title: '20 个开奖号码之和（210–1410）' },
  { label: '跨度', title: '最大号 − 最小号' },
  { label: '奇偶比', title: '奇数个数 : 偶数个数' },
  { label: '大小比', title: '大号（41–80） : 小号（1–40）' },
  { label: '四区比', title: '1–20 : 21–40 : 41–60 : 61–80' },
  { label: '连号', title: '相邻号码连号组数' },
] as const

/** 快乐8走势图右侧的逐期指标栏。 */
export const Kl8IndicatorRail = memo(function Kl8IndicatorRail({ rows }: Kl8IndicatorRailProps) {
  const indicators = useMemo(() => rows.map((row) => getKl8Indicators(row.numbers)), [rows])
  const summary = useMemo(() => summarizeIndicators(indicators), [indicators])

  return (
    <section className="trend-panel dlt-metrics kl8-metrics" aria-label="快乐8逐期指标">
      <div className="trend-panel__header">
        <div>
          <p className="trend-panel__eyebrow">逐期指标</p>
          <h3>开奖指标</h3>
        </div>
        <span className="trend-panel__caption">20 个号码逐期统计</span>
      </div>

      <div className="dlt-metrics__table">
        <div className="dlt-metrics__head is-kl8">
          {METRIC_HEADERS.map((header) => (
            <span key={header.label} title={header.title}>
              {header.label}
            </span>
          ))}
        </div>

        <div
          className="dlt-metrics__summary"
          title={summary ? `本页 ${summary.sampleSize} 期指标的算术平均` : '暂无可统计的指标'}
        >
          {summary ? (
            <>
              <span className="dlt-metrics__summary-label">本页均值</span>
              <span>和值 {formatAverage(summary.averageSum)}</span>
              <span>跨度 {formatAverage(summary.averageSpan)}</span>
              <span>奇数 {formatAverage(summary.averageOdd)} 个</span>
              <span>大号 {formatAverage(summary.averageBig)} 个</span>
              <span>
                四区 {summary.averageZones.map((value) => formatAverage(value)).join(':')}
              </span>
            </>
          ) : (
            <span className="dlt-metrics__summary-empty">本页暂无可统计的号码</span>
          )}
        </div>

        <div className="dlt-metrics__body">
          {rows.map((row, index) => {
            const item = indicators[index]
            return (
              <div
                key={row.issue}
                className={`dlt-metrics__row is-kl8${index % 2 === 1 ? ' is-alt' : ''}`}
              >
                <span className="is-sum">{item ? item.sum : '--'}</span>
                <span>{item ? item.span : '--'}</span>
                <span>{item ? formatOddEven(item) : '--'}</span>
                <span>{item ? formatBigSmall(item) : '--'}</span>
                <span>{item ? formatZones(item) : '--'}</span>
                <span>{item ? item.consecutive : '--'}</span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
})
