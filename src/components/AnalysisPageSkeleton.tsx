type AnalysisPageSkeletonProps = {
  variant: 'history' | 'math'
}

const HERO_CARD_COUNT = 5
const HISTORY_CONTROL_COUNT = 5

export function AnalysisSummarySkeleton({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className="analysis-skeleton__chip"
          style={{ width: `${5.4 + (index % 3) * 0.7}rem` }}
          aria-hidden="true"
        />
      ))}
    </>
  )
}

/** 分析页 / 数学走势页的首屏骨架，覆盖预测卡、参数面板与走势卡。 */
export function AnalysisPageSkeleton({ variant }: AnalysisPageSkeletonProps) {
  const isMath = variant === 'math'

  return (
    <div className="analysis-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="analysis-skeleton__sr">正在加载分析数据…</span>

      <section
        className={`prediction-hero ${
          isMath ? 'prediction-hero--math' : 'prediction-hero--classic'
        }`}
      >
        <div className="prediction-hero__main">
          <div className="analysis-skeleton__hero-copy">
            <span
              className="analysis-skeleton__bar analysis-skeleton__bar--light"
              style={{ width: '6.5rem' }}
            />
            <span className="analysis-skeleton__bar analysis-skeleton__bar--light analysis-skeleton__bar--hero" />
          </div>
          <div className="prediction-hero__metrics">
            {Array.from({ length: 3 }, (_, index) => (
              <span key={index} className="analysis-skeleton__pill" />
            ))}
          </div>
        </div>

        <div className="prediction-hero__grid">
          {Array.from({ length: HERO_CARD_COUNT }, (_, index) => (
            <article key={index} className="prediction-hero__card">
              <span className="analysis-skeleton__bar analysis-skeleton__bar--light" />
              <span
                className="analysis-skeleton__bar analysis-skeleton__bar--light analysis-skeleton__bar--digit"
                style={{ width: `${4.6 + (index % 3) * 0.6}rem` }}
              />
              <span className="analysis-skeleton__bar analysis-skeleton__bar--light" />
            </article>
          ))}
        </div>

        <div className="prediction-hero__secondary">
          <span className="analysis-skeleton__bar analysis-skeleton__bar--light" style={{ width: '4.2rem' }} />
          <div className="prediction-hero__secondary-list">
            {Array.from({ length: 4 }, (_, index) => (
              <span key={index} className="analysis-skeleton__pill analysis-skeleton__pill--small" />
            ))}
          </div>
        </div>
      </section>

      {isMath ? <MathBodySkeleton /> : <HistoryBodySkeleton />}
    </div>
  )
}

function HistoryBodySkeleton() {
  return (
    <>
      <section className="analysis-controls">
        <div className="analysis-controls__header">
          <div className="analysis-skeleton__line-list">
            <span className="analysis-skeleton__bar" style={{ width: '4.8rem' }} />
            <span className="analysis-skeleton__bar analysis-skeleton__bar--title" />
          </div>
          <span className="analysis-skeleton__bar" style={{ width: '12rem' }} />
        </div>

        <div className="analysis-controls__grid">
          {Array.from({ length: HISTORY_CONTROL_COUNT }, (_, index) => (
            <article key={index} className="analysis-control-card">
              <div className="analysis-control-card__top">
                <div className="analysis-skeleton__line-list">
                  <span className="analysis-skeleton__bar" style={{ width: '5rem' }} />
                  <span className="analysis-skeleton__bar" style={{ width: '11rem' }} />
                </div>
                <span className="analysis-skeleton__bar" style={{ width: '4.2rem' }} />
              </div>
              <span className="analysis-skeleton__track" />
            </article>
          ))}
        </div>
      </section>

      <section className="analysis-overview">
        {Array.from({ length: 3 }, (_, index) => (
          <article key={index} className="analysis-overview__panel">
            <span className="analysis-skeleton__bar analysis-skeleton__bar--title" style={{ width: '4.8rem' }} />
            <div className="analysis-skeleton__line-list analysis-skeleton__line-list--loose">
              {Array.from({ length: index === 1 ? 5 : 7 }, (_, lineIndex) => (
                <span
                  key={lineIndex}
                  className="analysis-skeleton__bar"
                  style={{ width: `${6.5 + ((lineIndex + index) % 4) * 1.1}rem` }}
                />
              ))}
            </div>
          </article>
        ))}
      </section>

      <PositionSkeleton />
    </>
  )
}

function MathBodySkeleton() {
  return (
    <>
      <section className="analysis-overview">
        {Array.from({ length: 3 }, (_, index) => (
          <article key={index} className="analysis-overview__panel">
            <span className="analysis-skeleton__bar analysis-skeleton__bar--title" style={{ width: '4.4rem' }} />
            {index === 1 ? (
              <div className="analysis-skeleton__pill-row">
                {Array.from({ length: 4 }, (_, pillIndex) => (
                  <span key={pillIndex} className="analysis-skeleton__pill analysis-skeleton__pill--light" />
                ))}
              </div>
            ) : (
              <div className="analysis-skeleton__line-list analysis-skeleton__line-list--loose">
                {Array.from({ length: 4 }, (_, lineIndex) => (
                  <span key={lineIndex} className="analysis-skeleton__bar" style={{ width: `${8 + lineIndex}rem` }} />
                ))}
              </div>
            )}
          </article>
        ))}
      </section>

      <section className="math-trend-page__principles">
        {Array.from({ length: 4 }, (_, index) => (
          <article key={index} className="math-trend-page__principle-card">
            <span className="analysis-skeleton__circle" />
            <span className="analysis-skeleton__bar analysis-skeleton__bar--title" style={{ width: '8rem' }} />
            <span className="analysis-skeleton__bar" style={{ width: '100%' }} />
            <span className="analysis-skeleton__bar" style={{ width: '82%' }} />
          </article>
        ))}
      </section>

      <PositionSkeleton />
    </>
  )
}

function PositionSkeleton() {
  return (
    <section className="analysis-positions">
      <div className="analysis-positions__header">
        <div className="analysis-skeleton__line-list">
          <span className="analysis-skeleton__bar" style={{ width: '4rem' }} />
          <span className="analysis-skeleton__bar analysis-skeleton__bar--title" style={{ width: '12rem' }} />
        </div>
        <div className="analysis-skeleton__pill-row">
          {Array.from({ length: 5 }, (_, index) => (
            <span key={index} className="analysis-skeleton__pill analysis-skeleton__pill--light" />
          ))}
        </div>
      </div>

      <article className="analysis-position-card">
        <div className="analysis-position-card__header">
          <div className="analysis-skeleton__line-list">
            <span className="analysis-skeleton__bar" style={{ width: '4rem' }} />
            <span className="analysis-skeleton__bar analysis-skeleton__bar--title" style={{ width: '7rem' }} />
          </div>
          <div className="analysis-skeleton__pill-row">
            {Array.from({ length: 4 }, (_, index) => (
              <span key={index} className="analysis-skeleton__pill analysis-skeleton__pill--light" />
            ))}
          </div>
        </div>
        <div className="analysis-skeleton__chart" />
      </article>
    </section>
  )
}
