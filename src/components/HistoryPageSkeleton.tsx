const TREND_DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

/** 开奖历史首屏骨架：预测摘要 + 5 列走势大表。 */
export function HistoryPageSkeleton() {
  return (
    <div className="history-page-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="analysis-skeleton__sr">正在加载开奖历史与分析数据…</span>

      <section className="history-insight" aria-hidden="true">
        <div className="history-insight__header">
          <div className="analysis-skeleton__line-list">
            <span className="analysis-skeleton__bar" style={{ width: '5rem' }} />
            <span className="analysis-skeleton__bar analysis-skeleton__bar--title" style={{ width: '18rem' }} />
          </div>
          <span className="analysis-skeleton__bar" style={{ width: '14rem' }} />
        </div>

        <div className="history-insight__metrics">
          {Array.from({ length: 3 }, (_, index) => (
            <article key={index} className="history-insight__metric">
              <span className="analysis-skeleton__bar" style={{ width: '5.5rem' }} />
              <span className="analysis-skeleton__bar analysis-skeleton__bar--title" style={{ width: '4rem' }} />
            </article>
          ))}
        </div>

        <div className="history-insight__numbers">
          <span className="analysis-skeleton__bar" style={{ width: '4.2rem' }} />
          <div className="history-insight__numbers-list">
            {Array.from({ length: 5 }, (_, index) => (
              <span key={index} className="analysis-skeleton__pill analysis-skeleton__pill--light" />
            ))}
          </div>
        </div>
      </section>

      <div className="history-page__desktop history-page-skeleton__desktop" aria-hidden="true">
        <section className="trend-axis">
          <div className="trend-axis__spacer" />
          <div className="trend-axis__header">
            <span className="analysis-skeleton__bar" style={{ width: '4.5rem' }} />
          </div>
          <div className="history-page-skeleton__axis-grid" />
        </section>

        {Array.from({ length: 5 }, (_, panelIndex) => (
          <section key={panelIndex} className="trend-panel">
            <div className="trend-panel__header">
              <div className="analysis-skeleton__line-list">
                <span className="analysis-skeleton__bar" style={{ width: '3.8rem' }} />
                <span className="analysis-skeleton__bar analysis-skeleton__bar--title" style={{ width: '3.4rem' }} />
              </div>
              <span className="analysis-skeleton__bar" style={{ width: '3.2rem' }} />
            </div>

            <div className="trend-panel__table">
              <div className="trend-panel__table-head">
                <div className="history-page-skeleton__digits">
                  {TREND_DIGITS.map((digit) => (
                    <span key={digit} />
                  ))}
                </div>
              </div>
              <div className="history-page-skeleton__trend-grid" />
            </div>
          </section>
        ))}
      </div>

      <ul className="history-page__list history-page__mobile history-page-skeleton__mobile" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <li key={index} className="history-card history-page-skeleton__card">
            <div className="history-card__head">
              <div className="analysis-skeleton__line-list">
                <span className="analysis-skeleton__bar" style={{ width: '4.8rem' }} />
                <span className="analysis-skeleton__bar analysis-skeleton__bar--title" style={{ width: '6rem' }} />
              </div>
              <span className="analysis-skeleton__bar" style={{ width: '4rem' }} />
            </div>
            <div className="history-page-skeleton__balls">
              {Array.from({ length: 5 }, (_, ballIndex) => (
                <span key={ballIndex} />
              ))}
            </div>
            <div className="history-card__meta">
              {Array.from({ length: 4 }, (_, metaIndex) => (
                <span key={metaIndex} className="analysis-skeleton__bar" />
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
