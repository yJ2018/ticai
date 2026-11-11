import { memo } from 'react'
import type { RecommendationHitResponse } from '../domain/recommendationHits'

type RecommendationHitPanelProps = {
  gameLabel: string
  data: RecommendationHitResponse | null
  loading: boolean
  error: string
}

/**
 * 「推荐命中记录」卡：每期开奖前给出的推荐，开奖后核对命中与奖级。
 *
 * 号码池彩种（大乐透 / 双色球 / 快乐8）共用一套结构：
 *   - 顶部：样本、平均命中、覆盖率 vs 理论、中奖期数；
 *   - 中部：命中分布条 + 奖级分布；
 *   - 底部：最近 N 期的推荐 / 实际 / 命中明细。
 */
export const RecommendationHitPanel = memo(function RecommendationHitPanel({
  gameLabel,
  data,
  loading,
  error,
}: RecommendationHitPanelProps) {
  if (!data && loading) {
    return (
      <section className="rec-hit" aria-label={`${gameLabel}推荐命中记录`}>
        <header className="rec-hit__header">
          <div>
            <p className="rec-hit__eyebrow">推荐命中</p>
            <h3>正在核对逐期命中…</h3>
          </div>
        </header>
      </section>
    )
  }

  if (!data || !data.ready || !data.summary) {
    return (
      <section className="rec-hit rec-hit--empty" aria-label={`${gameLabel}推荐命中记录`}>
        <header className="rec-hit__header">
          <div>
            <p className="rec-hit__eyebrow">推荐命中</p>
            <h3>还没有逐期命中记录</h3>
          </div>
        </header>
        <p className="rec-hit__empty">
          {error || '至少需要 30 期开奖记录；爬虫开奖入库后会自动补齐最近 300 期归档。'}
        </p>
      </section>
    )
  }

  const summary = data.summary
  const overall = summary.overall
  const shape = summary.shape
  const window30 = summary.windows.find((item) => item.window === 30) ?? null
  const window100 = summary.windows.find((item) => item.window === 100) ?? null
  const distributionMax = Math.max(
    1,
    ...summary.distribution.main.map((item) => item.count),
  )

  return (
    <section className="rec-hit" aria-label={`${gameLabel}推荐命中记录`}>
      <header className="rec-hit__header">
        <div>
          <p className="rec-hit__eyebrow">推荐命中 · walk-forward</p>
          <h3>
            {gameLabel} · 已核对 {formatCount(overall.samples)} 期
          </h3>
        </div>
        <p className="rec-hit__desc">
          第 N 期参考只使用第 N-1 期及以前的数据
          {summary.sample.fromIssue ? ` · ${summary.sample.fromIssue} → ${summary.sample.toIssue}` : ''}
          {data.stale ? ' · 有一期新开奖待归档' : ''}
        </p>
      </header>

      <div className="rec-hit__metrics">
        <article className="rec-hit__metric">
          <span>平均命中</span>
          <strong>
            {overall.avgMainHits.toFixed(2)}
            {shape.actualExtra > 0 ? ` + ${overall.avgExtraHits.toFixed(2)}` : ''}
          </strong>
          <em>
            每期与 {shape.actualMain} 个开奖号
            {shape.actualExtra > 0 ? ` + ${shape.actualExtra} 个特别号` : ''}核对
          </em>
        </article>
        <article className="rec-hit__metric">
          <span>覆盖率</span>
          <strong>{formatRate(overall.captureRate)}</strong>
          <em>理论 {formatRate(shape.mainPickRate)} · 提升 {formatLift(overall.lift)}</em>
        </article>
        <article className="rec-hit__metric">
          <span>近 30 期平均</span>
          <strong>{window30 ? window30.avgMainHits.toFixed(2) : '--'}</strong>
          <em>
            {window30
              ? `提升 ${formatLift(window30.lift)} · ${window30.winningIssues} 期中奖`
              : '暂无 30 期样本'}
          </em>
        </article>
        <article className="rec-hit__metric">
          <span>中奖期数</span>
          <strong>{formatCount(overall.winningIssues)}</strong>
          <em>
            {formatRate(overall.winningRate)}
            {overall.bestTier ? ` · 历史最高 ${overall.bestTier}` : ' · 暂无奖级'}
          </em>
        </article>
      </div>

      <div className="rec-hit__body">
        <div className="rec-hit__distribution" aria-label="命中分布">
          <div className="rec-hit__section-head">
            <span>命中分布</span>
            <em>横轴：每期命中的开奖号个数</em>
          </div>
          <div className="rec-hit__bars">
            {summary.distribution.main.map((item) => (
              <div
                key={`hit-dist-${item.hits}`}
                className="rec-hit__bar"
                title={`${item.hits} 个：${item.count} 期（${formatRate(item.rate)}）`}
              >
                <span
                  className="rec-hit__bar-fill"
                  style={{ height: `${Math.max(4, (item.count / distributionMax) * 100)}%` }}
                />
                <em>{item.hits}</em>
              </div>
            ))}
          </div>
          <div className="rec-hit__window-row">
            {summary.windows.map((item) => (
              <span key={`hit-window-${item.window}`}>
                近 {item.window} 期 <strong>{formatRate(item.captureRate)}</strong>
              </span>
            ))}
          </div>
        </div>

        <div className="rec-hit__tiers" aria-label="奖级分布">
          <div className="rec-hit__section-head">
            <span>奖级分布</span>
            <em>按每期最好成绩计</em>
          </div>
          {summary.tiers.length > 0 ? (
            <ul className="rec-hit__tier-list">
              {summary.tiers.map((item) => (
                <li key={`hit-tier-${item.tier}`}>
                  <span>{item.tier}</span>
                  <strong>{formatCount(item.count)} 期</strong>
                  <em>{formatRate(item.rate)}</em>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rec-hit__empty">归档区间内还没有中奖期。</p>
          )}
          <div className="rec-hit__window-row">
            <span>
              近 100 期 <strong>{window100 ? formatRate(window100.captureRate) : '--'}</strong>
            </span>
            <span>
              归档区间 {summary.sample.fromIssue ?? '--'} → {summary.sample.toIssue ?? '--'}
            </span>
          </div>
        </div>
      </div>

      <div className="rec-hit__recent">
        <div className="rec-hit__section-head">
          <span>逐期记录</span>
          <em>推荐号码 / 实际开奖 / 命中</em>
        </div>
        <ul className="rec-hit__list">
          {data.items.slice(0, 12).map((item) => (
            <li key={`hit-item-${item.issue}`} className="rec-hit__item">
              <div className="rec-hit__item-head">
                <div>
                  <strong>第 {item.issue} 期</strong>
                  <span>{item.drawDate}</span>
                </div>
                <div className="rec-hit__item-score">
                  <span>
                    命中 {item.hits.main}/{shape.actualMain}
                    {shape.actualExtra > 0 ? ` + ${item.hits.extra}/${shape.actualExtra}` : ''}
                  </span>
                  {item.ticket.tier && <em>{item.ticket.tier}</em>}
                </div>
              </div>
              <div className="rec-hit__numbers">
                <span className="rec-hit__numbers-label">推荐</span>
                <NumberRow
                  kind={summary.kind}
                  numbers={item.prediction.main}
                  extra={item.prediction.extra}
                  actualMain={item.actual.main}
                  actualExtra={item.actual.extra}
                />
              </div>
              <div className="rec-hit__numbers">
                <span className="rec-hit__numbers-label">实际</span>
                <NumberRow
                  kind={summary.kind}
                  numbers={item.actual.main}
                  extra={item.actual.extra}
                  actualMain={item.actual.main}
                  actualExtra={item.actual.extra}
                  actual
                />
              </div>
              {item.prediction.primaryMain && item.prediction.primaryExtra && (
                <div className="rec-hit__numbers">
                  <span className="rec-hit__numbers-label">主推</span>
                  <NumberRow
                    kind={summary.kind}
                    numbers={item.prediction.primaryMain}
                    extra={item.prediction.primaryExtra}
                    actualMain={item.actual.main}
                    actualExtra={item.actual.extra}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
})

function NumberRow({
  kind,
  numbers,
  extra,
  actualMain,
  actualExtra,
  actual = false,
}: {
  kind: string
  numbers: number[]
  extra: number[]
  actualMain: number[]
  actualExtra: number[]
  actual?: boolean
}) {
  const mainHits = new Set(actualMain)
  const extraHits = new Set(actualExtra)
  const mainClass = kind === 'kl8' ? 'is-kl8' : undefined
  const extraClass = kind === 'dlt' || kind === 'ssq' ? 'is-back' : undefined

  return (
    <span className="rec-hit__number-row">
      {numbers.map((number) => (
        <span
          key={`${kind}-main-${number}`}
          className={`rec-hit__number ${mainClass ?? ''}${actual || mainHits.has(number) ? ' is-hit' : ''}`}
        >
          {pad(number)}
        </span>
      ))}
      {extra.length > 0 && (
        <>
          <span className="rec-hit__plus" aria-hidden="true">
            +
          </span>
          {extra.map((number) => (
            <span
              key={`${kind}-extra-${number}`}
              className={`rec-hit__number ${extraClass ?? ''}${actual || extraHits.has(number) ? ' is-hit' : ''}`}
            >
              {pad(number)}
            </span>
          ))}
        </>
      )}
    </span>
  )
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function formatCount(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatRate(value: number) {
  if (!Number.isFinite(value)) {
    return '--'
  }
  return `${(value * 100).toFixed(1)}%`
}

function formatLift(value: number) {
  if (!Number.isFinite(value)) {
    return '--'
  }
  return `${value >= 1 ? '+' : ''}${((value - 1) * 100).toFixed(1)}%`
}
