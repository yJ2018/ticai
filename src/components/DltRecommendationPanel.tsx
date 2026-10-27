import { memo, useMemo } from 'react'
import {
  analyzeDltRecommendation,
  type DltRecommendation,
  type DltRecommendationEntry,
} from '../domain/dltRecommendation'
import { formatDltBigSmall, formatDltOddEven, formatDltZones } from '../domain/dltIndicators'

type DltRecommendationPanelProps = {
  /** 传了就直接渲染（服务端快照）；没传才用本地开奖记录现算 */
  recommendation?: DltRecommendation | null
  entries?: DltRecommendationEntry[]
}

/**
 * 大乐透号码推演卡。
 *
 * 桌面端放在走势图上方，左栏是号码与结构指标，右栏是逐条理由；
 * 移动端与桌面共用同一份 DOM，窄屏自动上下堆叠。
 *
 * 数据来源：优先用服务端算好的快照（`recommendation`），
 * 这样展示的一定是最近 300 期全量样本，与本地缓存是否同步完无关。
 */
export const DltRecommendationPanel = memo(function DltRecommendationPanel({
  recommendation: provided,
  entries = [],
}: DltRecommendationPanelProps) {
  const computed = useMemo(() => analyzeDltRecommendation(entries), [entries])
  const recommendation = provided ?? computed

  if (!recommendation) {
    return (
      <section className="dlt-recommend dlt-recommend--empty" aria-label="大乐透号码参考">
        <div>
          <p className="dlt-recommend__eyebrow">数据推演 · 下期参考</p>
          <h3>样本不足，暂不生成号码</h3>
        </div>
        <p className="dlt-recommend__empty">
          至少需要 30 期开奖记录；服务端分析还没生成时，可稍后刷新或执行 npm run analyze:snapshot。
        </p>
      </section>
    )
  }

  const { picks, alternates, metrics, windows } = recommendation
  const windowLabel = Array.from(new Set([windows.short, windows.recent, windows.long])).join(' / ')

  return (
    <section className="dlt-recommend" aria-label="大乐透号码参考">
      <header className="dlt-recommend__header">
        <div>
          <p className="dlt-recommend__eyebrow">数据推演 · 下期参考</p>
          <h3 title="分析窗口最多取最近 300 期，兼顾近期规律与计算稳定性">
            近 {windowLabel} 期 · 前区 5 + 后区 2
          </h3>
        </div>
        <p className="dlt-recommend__desc">
          综合频次、遗漏与和值 / 跨度 / 奇偶 / 大小 / 三区形态筛选，仅作娱乐参考。
        </p>
      </header>

      <div className="dlt-recommend__body">
        <div className="dlt-recommend__main">
          <div className="dlt-recommend__ticket">
            <div className="dlt-recommend__group">
              <span className="dlt-recommend__label">前区</span>
              <div className="dlt-recommend__balls">
                {picks.front.map((number) => (
                  <span key={`front-${number}`} className="dlt-recommend__ball">
                    {pad(number)}
                  </span>
                ))}
              </div>
            </div>
            <span className="dlt-recommend__plus" aria-hidden="true">
              +
            </span>
            <div className="dlt-recommend__group">
              <span className="dlt-recommend__label">后区</span>
              <div className="dlt-recommend__balls">
                {picks.back.map((number) => (
                  <span key={`back-${number}`} className="dlt-recommend__ball is-back">
                    {pad(number)}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="dlt-recommend__metrics">
            <span className="dlt-recommend__metric">
              和值 <strong>{metrics.front.sum}</strong>
            </span>
            <span className="dlt-recommend__metric">
              跨度 <strong>{metrics.front.span}</strong>
            </span>
            <span className="dlt-recommend__metric">
              奇偶 <strong>{formatDltOddEven(metrics.front)}</strong>
            </span>
            <span className="dlt-recommend__metric">
              大小 <strong>{formatDltBigSmall(metrics.front)}</strong>
            </span>
            <span className="dlt-recommend__metric">
              三区 <strong>{formatDltZones(metrics.front)}</strong>
            </span>
            <span className="dlt-recommend__metric is-back">
              后区和值 <strong>{metrics.back.sum}</strong>
            </span>
          </div>

          {alternates.front.length > 0 && (
            <div className="dlt-recommend__alternates">
              <span className="dlt-recommend__alternates-group">
                <span className="dlt-recommend__alternates-label">备选前区</span>
                {alternates.front.map((number) => (
                  <span key={`alt-front-${number}`} className="dlt-recommend__alternate">
                    {pad(number)}
                  </span>
                ))}
              </span>
              {alternates.back.length > 0 && (
                <span className="dlt-recommend__alternates-group">
                  <span className="dlt-recommend__alternates-label is-back">备选后区</span>
                  {alternates.back.map((number) => (
                    <span key={`alt-back-${number}`} className="dlt-recommend__alternate is-back">
                      {pad(number)}
                    </span>
                  ))}
                </span>
              )}
            </div>
          )}
        </div>

        <ol className="dlt-recommend__reasons" aria-label="分析理由">
          {recommendation.reasons.map((reason, index) => (
            <li key={`${index}-${reason}`} className="dlt-recommend__reason">
              <span className="dlt-recommend__reason-index">{index + 1}</span>
              <span>{reason}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
})

function pad(value: number) {
  return String(value).padStart(2, '0')
}
