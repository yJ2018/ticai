import { memo, type ReactNode } from 'react'
import { type SsqRecommendation } from '../domain/welfareAnalysis'
import { formatBigSmall, formatOddEven, formatZones } from '../domain/welfareIndicators'

type SsqRecommendationPanelProps = {
  recommendation?: SsqRecommendation | null
  /** 推荐卡右上角的一键投注按钮 */
  quickBet?: ReactNode
}

/**
 * 双色球号码推演卡。
 *
 * 红球 12 码池 + 蓝球 4 码池，主推 6+1 单注；右侧逐条解释冷热、遗漏、三区与形态。
 * 数据只来自服务端快照，前端不做任何算法计算。
 */
export const SsqRecommendationPanel = memo(function SsqRecommendationPanel({
  recommendation,
  quickBet,
}: SsqRecommendationPanelProps) {
  if (!recommendation) {
    return (
      <section className="dlt-recommend ssq-recommend dlt-recommend--empty" aria-label="双色球号码参考">
        <div>
          <p className="dlt-recommend__eyebrow">数据推演 · 下期参考</p>
          <h3>样本不足，暂不生成号码</h3>
        </div>
        <p className="dlt-recommend__empty">
          至少需要 30 期开奖记录；服务端分析还没生成时，可稍后刷新或执行 npm run analyze:snapshot --game=ssq。
        </p>
      </section>
    )
  }

  const { red, blue, reasons, windows } = recommendation
  const windowLabel = Array.from(new Set([windows.short, windows.recent, windows.long])).join(' / ')

  return (
    <section className="dlt-recommend ssq-recommend" aria-label="双色球号码参考">
      <header className="dlt-recommend__header">
        <div>
          <p className="dlt-recommend__eyebrow">数据推演 · 下期参考</p>
          <h3 title="分析窗口最多取最近 300 期；红球按三区各取 4 码，蓝球取 4 码">
            近 {windowLabel} 期 · 红球 12 码 + 蓝球 4 码
          </h3>
        </div>
        <div className="dlt-recommend__header-side">
          <p className="dlt-recommend__desc">
            红球按一区 / 二区 / 三区各取 4 码，结合频次、遗漏、重号与邻号；蓝球单独按冷热与遗漏排序。
            仅作娱乐参考。
          </p>
          {quickBet && <div className="dlt-recommend__quick">{quickBet}</div>}
        </div>
      </header>

      <div className="dlt-recommend__body">
        <div className="dlt-recommend__main">
          <div className="dlt-recommend__ticket">
            <div className="dlt-recommend__group">
              <span className="dlt-recommend__label">主推红球</span>
              <div className="dlt-recommend__balls">
                {red.primary.map((number) => (
                  <span key={`red-primary-${number}`} className="dlt-recommend__ball">
                    {pad(number)}
                  </span>
                ))}
              </div>
            </div>
            <span className="dlt-recommend__plus" aria-hidden="true">
              +
            </span>
            <div className="dlt-recommend__group">
              <span className="dlt-recommend__label">主推蓝球</span>
              <div className="dlt-recommend__balls">
                {blue.primary.map((number) => (
                  <span key={`blue-primary-${number}`} className="dlt-recommend__ball is-back">
                    {pad(number)}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="dlt-recommend__metrics">
            <span className="dlt-recommend__metric">
              和值 <strong>{red.metrics.sum}</strong>
            </span>
            <span className="dlt-recommend__metric">
              跨度 <strong>{red.metrics.span}</strong>
            </span>
            <span className="dlt-recommend__metric">
              奇偶 <strong>{formatOddEven(red.metrics)}</strong>
            </span>
            <span className="dlt-recommend__metric">
              大小 <strong>{formatBigSmall(red.metrics)}</strong>
            </span>
            <span className="dlt-recommend__metric">
              三区 <strong>{formatZones(red.metrics)}</strong>
            </span>
            <span className="dlt-recommend__metric is-back">
              蓝球 <strong>{pad(blue.primary[0] ?? 0)}</strong>
            </span>
          </div>

          <div className="ssq-recommend__pools">
            <div className="ssq-recommend__pool">
              <span className="dlt-recommend__alternates-label">红球 12 码池</span>
              <div className="ssq-recommend__pool-list">
                {red.picks.map((number) => (
                  <span
                    key={`red-pool-${number}`}
                    className={`ssq-recommend__pill${red.primary.includes(number) ? ' is-primary' : ''}`}
                  >
                    {pad(number)}
                  </span>
                ))}
              </div>
            </div>
            <div className="ssq-recommend__pool">
              <span className="dlt-recommend__alternates-label is-back">蓝球 4 码池</span>
              <div className="ssq-recommend__pool-list">
                {blue.picks.map((number) => (
                  <span
                    key={`blue-pool-${number}`}
                    className={`ssq-recommend__pill is-back${blue.primary.includes(number) ? ' is-primary' : ''}`}
                  >
                    {pad(number)}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {red.alternates.length > 0 && (
            <div className="dlt-recommend__alternates">
              <span className="dlt-recommend__alternates-group">
                <span className="dlt-recommend__alternates-label">备选红球</span>
                {red.alternates.map((number) => (
                  <span key={`alt-red-${number}`} className="dlt-recommend__alternate">
                    {pad(number)}
                  </span>
                ))}
              </span>
              {blue.alternates.length > 0 && (
                <span className="dlt-recommend__alternates-group">
                  <span className="dlt-recommend__alternates-label is-back">备选蓝球</span>
                  {blue.alternates.map((number) => (
                    <span key={`alt-blue-${number}`} className="dlt-recommend__alternate is-back">
                      {pad(number)}
                    </span>
                  ))}
                </span>
              )}
            </div>
          )}
        </div>

        <ol className="dlt-recommend__reasons" aria-label="双色球分析理由">
          {reasons.map((reason, index) => (
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
