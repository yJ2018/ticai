import { memo, useMemo } from 'react'
import { type LotteryHistoryEntry } from '../domain/lotteryHistory'
import {
  formatDltAverage,
  formatDltBigSmall,
  formatDltOddEven,
  formatDltZones,
  getDltFrontIndicators,
  summarizeDltFrontIndicators,
} from '../domain/dltIndicators'

type DltIndicatorRailProps = {
  rows: LotteryHistoryEntry[]
}

const METRIC_HEADERS = [
  { label: '和值', title: '前区 5 个号码之和（15–165）' },
  { label: '跨度', title: '前区最大号 − 最小号（4–34）' },
  { label: '奇偶比', title: '前区奇数个数 : 偶数个数' },
  { label: '大小比', title: '前区大号（18–35） : 小号（1–17）' },
  { label: '三区比', title: '一区 1–12 : 二区 13–24 : 三区 25–35' },
] as const

/**
 * 大乐透走势图右侧的逐期指标栏。
 *
 * 行高与左侧号码矩阵、期号轴共用同一套尺寸（表头 2.125rem、
 * 统计区 2.7rem、每期 1.875rem），三列才能在桌面上逐行对齐。
 */
export const DltIndicatorRail = memo(function DltIndicatorRail({ rows }: DltIndicatorRailProps) {
  const indicators = useMemo(() => rows.map((row) => getDltFrontIndicators(row.numbers)), [rows])
  const summary = useMemo(() => summarizeDltFrontIndicators(indicators), [indicators])

  return (
    <section className="trend-panel dlt-metrics" aria-label="大乐透前区逐期指标">
      <div className="trend-panel__header">
        <div>
          <p className="trend-panel__eyebrow">逐期指标</p>
          <h3>前区指标</h3>
        </div>
        <span className="trend-panel__caption">前区 5 个号码逐期统计</span>
      </div>

      <div className="dlt-metrics__table">
        <div className="dlt-metrics__head">
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
              <span>和值 {formatDltAverage(summary.averageSum)}</span>
              <span>跨度 {formatDltAverage(summary.averageSpan)}</span>
              <span>奇数 {formatDltAverage(summary.averageOdd)} 个</span>
              <span>大号 {formatDltAverage(summary.averageBig)} 个</span>
              <span>
                三区 {summary.averageZones.map((value) => formatDltAverage(value)).join(':')}
              </span>
            </>
          ) : (
            <span className="dlt-metrics__summary-empty">本页暂无可统计的前区号码</span>
          )}
        </div>

        <div className="dlt-metrics__body">
          {rows.map((row, index) => {
            const item = indicators[index]
            return (
              <div key={row.issue} className="dlt-metrics__row">
                <span className="is-sum">{item ? item.sum : '--'}</span>
                <span>{item ? item.span : '--'}</span>
                <span>{item ? formatDltOddEven(item) : '--'}</span>
                <span>{item ? formatDltBigSmall(item) : '--'}</span>
                <span>{item ? formatDltZones(item) : '--'}</span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
})
