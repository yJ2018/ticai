import { type LotteryHistoryGameType } from '../domain/lotteryHistory'

const TREND_DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
const FRONT_AXIS = Array.from({ length: 35 }, (_, index) => index + 1)
const BACK_AXIS = Array.from({ length: 12 }, (_, index) => index + 1)

type SkeletonMeta = {
  positional: boolean
  mainCount: number
  extraCount: number
}

/** 骨架屏按彩种变形：位次彩种铺走势列，大乐透铺明细表 */
const SKELETON_META: Record<LotteryHistoryGameType, SkeletonMeta> = {
  pl5: { positional: true, mainCount: 5, extraCount: 0 },
  qxc: { positional: true, mainCount: 7, extraCount: 0 },
  dlt: { positional: false, mainCount: 5, extraCount: 2 },
}

export function HistoryPageSkeleton({ game = 'pl5' }: { game?: LotteryHistoryGameType }) {
  const meta = SKELETON_META[game]
  const ballCount = meta.mainCount + meta.extraCount

  return (
    <div className="history-page-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="analysis-skeleton__sr">正在加载开奖历史与分析数据…</span>

      {meta.positional && (
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
                <span
                  className="analysis-skeleton__bar analysis-skeleton__bar--title"
                  style={{ width: '4rem' }}
                />
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
      )}

      <div
        className={`history-page__desktop history-page-skeleton__desktop${
          meta.positional ? '' : ' is-dlt'
        }`}
        aria-hidden="true"
        style={{
          gridTemplateColumns: meta.positional
            ? `5.1rem repeat(${meta.mainCount}, minmax(0, 1fr))`
            : '5.1rem minmax(0, 35fr) minmax(0, 12fr) 12.8rem',
        }}
      >
        <section className="trend-axis">
          <div className="trend-axis__spacer" />
          <div className="trend-axis__header">
            <span className="analysis-skeleton__bar" style={{ width: '4.5rem' }} />
          </div>
          {!meta.positional && <div className="history-page-skeleton__stats" />}
          <div className="history-page-skeleton__axis-grid" />
        </section>

        {(meta.positional
          ? Array.from({ length: meta.mainCount }, () => TREND_DIGITS)
          : [FRONT_AXIS, BACK_AXIS]
        ).map((axis, panelIndex) => (
          <section key={panelIndex} className="trend-panel">
            <div className="trend-panel__header">
              <div className="analysis-skeleton__line-list">
                <span className="analysis-skeleton__bar" style={{ width: '3.8rem' }} />
                <span
                  className="analysis-skeleton__bar analysis-skeleton__bar--title"
                  style={{ width: '3.4rem' }}
                />
              </div>
              <span className="analysis-skeleton__bar" style={{ width: '3.2rem' }} />
            </div>

            <div className="trend-panel__table">
              <div className="trend-panel__table-head">
                <div className="history-page-skeleton__digits">
                  {axis.map((value) => (
                    <span key={value} />
                  ))}
                </div>
              </div>
              {!meta.positional && <div className="history-page-skeleton__stats" />}
              <div className="history-page-skeleton__trend-grid" />
            </div>
          </section>
        ))}

        {!meta.positional && (
          <section className="trend-panel">
            <div className="trend-panel__header">
              <div className="analysis-skeleton__line-list">
                <span className="analysis-skeleton__bar" style={{ width: '3.8rem' }} />
                <span
                  className="analysis-skeleton__bar analysis-skeleton__bar--title"
                  style={{ width: '3.4rem' }}
                />
              </div>
              <span className="analysis-skeleton__bar" style={{ width: '4.8rem' }} />
            </div>

            <div className="trend-panel__table">
              <div className="history-page-skeleton__metric-head" />
              <div className="history-page-skeleton__stats" />
              <div className="history-page-skeleton__metric-grid" />
            </div>
          </section>
        )}
      </div>

      <ul className="history-page__list history-page__mobile history-page-skeleton__mobile" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <li key={index} className="history-card history-page-skeleton__card">
            <div className="history-card__head">
              <div className="analysis-skeleton__line-list">
                <span className="analysis-skeleton__bar" style={{ width: '4.8rem' }} />
                <span
                  className="analysis-skeleton__bar analysis-skeleton__bar--title"
                  style={{ width: '6rem' }}
                />
              </div>
              <span className="analysis-skeleton__bar" style={{ width: '4rem' }} />
            </div>
            <div className="history-page-skeleton__balls">
              {Array.from({ length: ballCount }, (_, ballIndex) => (
                <span
                  key={ballIndex}
                  className={ballIndex >= meta.mainCount ? 'is-back' : undefined}
                />
              ))}
            </div>
            {!meta.positional && (
              <div className="history-page-skeleton__indicator-row">
                {Array.from({ length: 5 }, (_, index) => (
                  <span key={index} className="analysis-skeleton__bar" style={{ width: '3.1rem' }} />
                ))}
              </div>
            )}
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
