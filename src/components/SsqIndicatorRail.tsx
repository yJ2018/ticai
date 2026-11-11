import { memo, useMemo } from 'react'
import { type LotteryHistoryEntry } from '../domain/lotteryHistory'
import {
  formatAverage,
  formatBigSmall,
  formatOddEven,
  formatZones,
  getSsqRedIndicators,
  summarizeIndicators,
} from '../domain/welfareIndicators'

type SsqIndicatorRailProps = {
  rows: LotteryHistoryEntry[]
}

const METRIC_HEADERS = [
  { label: '和值', title: '红球 6 个号码之和（21–183）' },
  { label: '跨度', title: '红球最大号 − 最小号（5–32）' },
  { label: '奇偶比', title: '红球奇数个数 : 偶数个数' },
  { label: '大小比', title: '红球大号（18–33） : 小号（1–17）' },
  { label: '三区比', title: '一区 1–11 : 二区 12–22 : 三区 23–33' },
  { label: '蓝球', title: '本期蓝球号码（1–16）' },
] as const

/**
 * 双色球走势图右侧的逐期指标栏。
 *
 * 行高与左侧红球 / 蓝球矩阵、期号轴共用同一套尺寸，桌面上四列逐行对齐。
 */
export const SsqIndicatorRail = memo(function SsqIndicatorRail({ rows }: SsqIndicatorRailProps) {
  const indicators = useMemo(() => rows.map((row) => getSsqRedIndicators(row.numbers)), [rows])
  const summary = useMemo(() => summarizeIndicators(indicators), [indicators])

  return (
    <section className="trend-panel dlt-metrics ssq-metrics" aria-label="双色球红球逐期指标">
      <div className="trend-panel__header">
        <div>
          <p className="trend-panel__eyebrow">逐期指标</p>
          <h3>红球指标</h3>
        </div>
        <span className="trend-panel__caption">红球 6 个号码逐期统计</span>
      </div>

      <div className="dlt-metrics__table">
        <div className="dlt-metrics__head is-ssq">
          {METRIC_HEADERS.map((header) => (
            <span key={header.label} title={header.title}>
              {header.label}
            </span>
          ))}
        </div>

        <div
          className="dlt-metrics__summary"
          title={summary ? `本页 ${summary.sampleSize} 期红球指标的算术平均` : '暂无可统计的指标'}
        >
          {summary ? (
            <>
              <span className="dlt-metrics__summary-label">本页均值</span>
              <span>和值 {formatAverage(summary.averageSum)}</span>
              <span>跨度 {formatAverage(summary.averageSpan)}</span>
              <span>奇数 {formatAverage(summary.averageOdd)} 个</span>
              <span>大号 {formatAverage(summary.averageBig)} 个</span>
              <span>
                三区 {summary.averageZones.map((value) => formatAverage(value)).join(':')}
              </span>
            </>
          ) : (
            <span className="dlt-metrics__summary-empty">本页暂无可统计的红球号码</span>
          )}
        </div>

        <div className="dlt-metrics__body">
          {rows.map((row, index) => {
            const item = indicators[index]
            const blue = row.numbers[6]
            return (
              <div
                key={row.issue}
                className={`dlt-metrics__row is-ssq${index % 2 === 1 ? ' is-alt' : ''}`}
              >
                <span className="is-sum">{item ? item.sum : '--'}</span>
                <span>{item ? item.span : '--'}</span>
                <span>{item ? formatOddEven(item) : '--'}</span>
                <span>{item ? formatBigSmall(item) : '--'}</span>
                <span>{item ? formatZones(item) : '--'}</span>
                <span className="is-blue">{blue ?? '--'}</span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
})
