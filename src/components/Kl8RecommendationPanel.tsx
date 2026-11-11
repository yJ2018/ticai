import { memo, type ReactNode } from 'react'
import { type Kl8Recommendation } from '../domain/welfareAnalysis'
import { formatBigSmall, formatOddEven, formatZones } from '../domain/welfareIndicators'

type Kl8RecommendationPanelProps = {
  recommendation?: Kl8Recommendation | null
  /** 推荐卡右上角的一键投注按钮 */
  quickBet?: ReactNode
}

/**
 * 快乐8号码推演卡。
 *
 * 20 码参考池（四区各 5 码）+ 选十 10 码主推；主推按近 30 期四区均值分配名额，
 * 再从池内按评分取号。数据只来自服务端快照。
 */
export const Kl8RecommendationPanel = memo(function Kl8RecommendationPanel({
  recommendation,
  quickBet,
}: Kl8RecommendationPanelProps) {
  if (!recommendation) {
    return (
      <section className="dlt-recommend kl8-recommend dlt-recommend--empty" aria-label="快乐8号码参考">
        <div>
          <p className="dlt-recommend__eyebrow">数据推演 · 下期参考</p>
          <h3>样本不足，暂不生成号码</h3>
        </div>
        <p className="dlt-recommend__empty">
          至少需要 30 期开奖记录；服务端分析还没生成时，可稍后刷新或执行 npm run analyze:snapshot --game=kl8。
        </p>
      </section>
    )
  }

  const { picks, metrics, reasons, windows, allocation } = recommendation
  const windowLabel = Array.from(new Set([windows.short, windows.recent, windows.long])).join(' / ')
  const primarySet = new Set(picks.primary)

  return (
    <section className="dlt-recommend kl8-recommend" aria-label="快乐8号码参考">
      <header className="dlt-recommend__header">
        <div>
          <p className="dlt-recommend__eyebrow">数据推演 · 下期参考</p>
          <h3 title="分析窗口最多取最近 300 期；选十主推从 20 码池里按四区配额取号">
            近 {windowLabel} 期 · 选十 10 码 + 20 码池
          </h3>
        </div>
        <div className="dlt-recommend__header-side">
          <p className="dlt-recommend__desc">
            80 个号码按近 10 / 30 / 100 期频次与遗漏评分，四区各取 5 码；选十主推按四区均值
            分配 {allocation.join(':')} 后从池内取号。仅作娱乐参考。
          </p>
          {quickBet && <div className="dlt-recommend__quick">{quickBet}</div>}
        </div>
      </header>

      <div className="dlt-recommend__body">
        <div className="dlt-recommend__main">
          <div className="dlt-recommend__ticket kl8-recommend__ticket">
            <div className="dlt-recommend__group">
              <span className="dlt-recommend__label">选十主推</span>
              <div className="dlt-recommend__balls">
                {picks.primary.map((number) => (
                  <span key={`kl8-primary-${number}`} className="dlt-recommend__ball is-kl8">
                    {pad(number)}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="dlt-recommend__metrics">
            <span className="dlt-recommend__metric">
              和值 <strong>{metrics.sum}</strong>
            </span>
            <span className="dlt-recommend__metric">
              跨度 <strong>{metrics.span}</strong>
            </span>
            <span className="dlt-recommend__metric">
              奇偶 <strong>{formatOddEven(metrics)}</strong>
            </span>
            <span className="dlt-recommend__metric">
              大小 <strong>{formatBigSmall(metrics)}</strong>
            </span>
            <span className="dlt-recommend__metric">
              四区 <strong>{formatZones(metrics)}</strong>
            </span>
            <span className="dlt-recommend__metric">
              连号 <strong>{metrics.consecutive}</strong>
            </span>
          </div>

          <div className="ssq-recommend__pools">
            <div className="ssq-recommend__pool">
              <span className="dlt-recommend__alternates-label">20 码参考池</span>
              <div className="ssq-recommend__pool-list">
                {picks.pool.map((number) => (
                  <span
                    key={`kl8-pool-${number}`}
                    className={`ssq-recommend__pill is-kl8${primarySet.has(number) ? ' is-primary' : ''}`}
                  >
                    {pad(number)}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>

        <ol className="dlt-recommend__reasons" aria-label="快乐8分析理由">
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
