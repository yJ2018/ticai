import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { type RecommendCandidate, type RecommendPlan } from '../../api/recommendApi'
import { candidateToLeg, type ParlayLeg } from './recommendation'
import { type AutoParlayScope, type AutoParlayState } from './useAutoParlay'
import './autoParlay.scss'

type AutoParlayPanelProps = {
  state: AutoParlayState
  poolLabel: string
  onApply: (legs: ParlayLeg[]) => void
  onClose: () => void
  onScopeChange: (scope: AutoParlayScope) => void
}

function percent(value: number) {
  const pct = value * 100
  if (pct >= 10) {
    return `${pct.toFixed(1)}%`
  }
  if (pct >= 1) {
    return `${pct.toFixed(1)}%`
  }
  return `${pct.toFixed(2)}%`
}

function signedPercent(value: number) {
  const text = `${(value * 100).toFixed(1)}%`
  return value >= 0 ? `+${text}` : text
}

const CONFIDENCE_LABEL = { high: '高', medium: '中', low: '低' } as const
/** 与服务端风控同一上限：单张投注单最多 3 场 */
const MAX_PLAN_LEGS = 3

type PlanCardProps = {
  plan: RecommendPlan
  candidates: RecommendCandidate[]
  extras: RecommendCandidate[]
  pickerOpen: boolean
  onTogglePicker: () => void
  onToggleCandidate: (candidate: RecommendCandidate) => void
  onApply: (legs: ParlayLeg[]) => void
}

function PlanCard({
  plan,
  candidates,
  extras,
  pickerOpen,
  onTogglePicker,
  onToggleCandidate,
  onApply,
}: PlanCardProps) {
  const planMatchIds = new Set(plan.legs.map((leg) => leg.matchId))
  const extraIds = new Set(extras.map((candidate) => candidate.matchId))
  const available = candidates.filter((candidate) => !planMatchIds.has(candidate.matchId) && !extraIds.has(candidate.matchId))
  const mergedLegs = [...plan.legs, ...extras]
  const mergedOdd = mergedLegs.reduce((product, leg) => product * leg.odd, 1)
  const mergedHit = mergedLegs.reduce((product, leg) => product * leg.blendP, 1)
  const remaining = MAX_PLAN_LEGS - mergedLegs.length
  const mergedLabel = mergedLegs.length === 1 ? '单关' : `${mergedLegs.length}串1`
  const overRisk = mergedLegs.length >= 2 && (mergedOdd > 8 || mergedHit < 0.15)
  const mergedParlayLegs: ParlayLeg[] = [
    ...plan.legs.map((leg) => ({
      matchId: leg.matchId,
      matchNo: leg.matchNo,
      teams: leg.teams,
      pick: { key: leg.optionKey, label: leg.optionLabel, odd: leg.odd },
    })),
    ...extras.map(candidateToLeg),
  ]

  return (
    <article className={`auto-parlay__plan is-${plan.id}`}>
      <header className="auto-parlay__plan-head">
        <div className="auto-parlay__plan-title">
          <strong>{plan.label}</strong>
          <span className={`auto-parlay__risk is-${plan.risk}`}>风险 {plan.risk}</span>
          {extras.length > 0 && <span className="auto-parlay__plan-merged">已补至 {mergedLabel}</span>}
        </div>
        <div className="auto-parlay__plan-stats">
          <span>
            总赔率 <b>{mergedOdd.toFixed(2)}</b>
          </span>
          <span>
            融合命中率 <b>{percent(mergedHit)}</b>
          </span>
          <span>
            期望回报{' '}
            <b className={mergedHit * mergedOdd >= 1 ? 'is-good' : 'is-bad'}>
              {(mergedHit * mergedOdd).toFixed(2)}×
            </b>
          </span>
        </div>
      </header>

      <ol className="auto-parlay__plan-legs">
        {plan.legs.map((leg) => (
          <li key={leg.matchId}>
            <div className="auto-parlay__leg-head">
              <strong>{leg.matchNo}</strong>
              <span>{leg.teams}</span>
              <em className="auto-parlay__role is-primary">{leg.poolLabel}</em>
            </div>
            <div className="auto-parlay__leg-meta">
              <b>{leg.optionLabel}</b>
              <span>@ {leg.odd.toFixed(2)}</span>
              <span>市场 {percent(leg.marketP)}</span>
              <span>融合 {percent(leg.blendP)}</span>
              {leg.goalExpectation && (
                <span className="auto-parlay__leg-goal">
                  期望总进球 {leg.goalExpectation.expectedTotal.toFixed(1)}
                  <em>（市场 {leg.goalExpectation.marketTotal.toFixed(1)}）</em>
                </span>
              )}
              <span className={leg.edge >= 0 ? 'is-good' : 'is-bad'}>{signedPercent(leg.edge)}</span>
              <span className="auto-parlay__leg-conf">置信 {CONFIDENCE_LABEL[leg.confidence]}</span>
            </div>
            <ul className="auto-parlay__reasons">
              {leg.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </li>
        ))}

        {extras.map((candidate) => (
          <li key={candidate.matchId} className="is-extra">
            <div className="auto-parlay__leg-head">
              <strong>{candidate.matchNo}</strong>
              <span>{candidate.teams}</span>
              <em className="auto-parlay__role is-manual">手动加入</em>
              <button
                type="button"
                className="auto-parlay__extra-remove"
                onClick={() => onToggleCandidate(candidate)}
                title="从串关里移除"
              >
                移除
              </button>
            </div>
            <div className="auto-parlay__leg-meta">
              <b>{candidate.optionLabel}</b>
              <span>@ {candidate.odd.toFixed(2)}</span>
              <span>融合 {percent(candidate.blendP)}</span>
              {candidate.rejectReason && <span className="is-off">{candidate.rejectReason}</span>}
            </div>
          </li>
        ))}
      </ol>

      <p className="auto-parlay__note">{plan.note}</p>

      {pickerOpen && (
        <div className="auto-parlay__extras">
          <p className="auto-parlay__extras-head">
            从候选里加串 · 还剩 {remaining} 席（最多 {MAX_PLAN_LEGS} 场）
          </p>
          {available.length === 0 ? (
            <p className="auto-parlay__extras-empty">没有可加入的候选了</p>
          ) : (
            <ul className="auto-parlay__extras-list">
              {available.map((candidate) => (
                <li key={candidate.matchId}>
                  <span className="auto-parlay__extras-match">
                    <strong>{candidate.matchNo}</strong> {candidate.teams}
                  </span>
                  <span className="auto-parlay__extras-pick">
                    {candidate.optionLabel} @{candidate.odd.toFixed(2)} · 融合 {percent(candidate.blendP)}
                  </span>
                  {candidate.rejectReason && <em className="is-off">{candidate.rejectReason}</em>}
                  <button type="button" disabled={remaining <= 0} onClick={() => onToggleCandidate(candidate)}>
                    加入
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {extras.length > 0 && (
        <p className={`auto-parlay__extras-preview${overRisk ? ' is-over' : ''}`}>
          手动组成 {mergedLabel} · 总赔率 {mergedOdd.toFixed(2)} · 参考命中率 {percent(mergedHit)}
          {overRisk ? ' · 超出自动风控（总赔率 ≤8 且命中率 ≥15%），仅作手动参考' : ''}
        </p>
      )}

      <footer className="auto-parlay__plan-foot">
        <span>
          {mergedLabel}
          {extras.length > 0 ? `（手动 ${extras.length} 场）` : ''}
        </span>
        <div className="auto-parlay__plan-actions">
          {remaining > 0 && (
            <button type="button" className="is-ghost" onClick={onTogglePicker} aria-expanded={pickerOpen}>
              {pickerOpen ? '收起候选' : `加入候选（剩 ${remaining} 席）`}
            </button>
          )}
          <button type="button" className="is-primary" onClick={() => onApply(mergedParlayLegs)}>
            应用{mergedLegs.length === 1 ? '单关' : `${mergedLegs.length}串1`}
          </button>
        </div>
      </footer>
    </article>
  )
}

/**
 * 一键推荐面板：方案 + 每条腿的数据理由 + 回测 + 过滤说明。
 * 数字全部来自服务端，前端不算概率。
 */
export function AutoParlayPanel({ state, poolLabel, onApply, onClose, onScopeChange }: AutoParlayPanelProps) {
  const open = state.poolType !== null
  const [progress, setProgress] = useState(0)
  const [pickerPlan, setPickerPlan] = useState<string | null>(null)
  const [extrasByPlan, setExtrasByPlan] = useState<Record<string, RecommendCandidate[]>>({})

  // 重新计算 / 换范围后，服务端方案变了，手动追加的腿要清空，避免串到旧方案上
  useEffect(() => {
    setPickerPlan(null)
    setExtrasByPlan({})
  }, [state.data, state.running])

  function toggleCandidate(planId: string, candidate: RecommendCandidate) {
    setExtrasByPlan((previous) => {
      const list = previous[planId] ?? []
      const exists = list.some((item) => item.matchId === candidate.matchId)
      return {
        ...previous,
        [planId]: exists
          ? list.filter((item) => item.matchId !== candidate.matchId)
          : [...list, candidate],
      }
    })
  }

  useEffect(() => {
    if (!open) {
      setProgress(0)
      return
    }
    if (state.running) {
      setProgress(6)
      const timer = window.setInterval(() => {
        setProgress((value) =>
          value >= 92 ? value : Math.min(92, value + Math.max(2, Math.round((92 - value) * 0.16))),
        )
      }, 420)
      return () => window.clearInterval(timer)
    }
    setProgress(state.data || state.error ? 100 : 0)
  }, [open, state.running, state.data, state.error])

  useEffect(() => {
    if (!open) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose])

  if (!open) {
    return null
  }

  const data = state.data
  const backtest = data?.backtest

  return createPortal(
    <div
      className="auto-parlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !state.running) {
          onClose()
        }
      }}
    >
      <section className="auto-parlay__card" role="dialog" aria-modal="true" aria-label="投注推荐">
        <header className="auto-parlay__head">
          <div>
            <p className="auto-parlay__eyebrow">投注推荐 · {data?.poolLabel ?? poolLabel}</p>
            <h2>
              {state.running
                ? '服务端正在算…'
                : data
                  ? data.plans.length > 0
                    ? `${data.plans.length} 个方案 · 覆盖 ${data.coverage.inScope} 场`
                    : `今天没有达门槛的方案`
                  : state.error || '推荐结果'}
            </h2>
          </div>
          <button type="button" className="auto-parlay__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="auto-parlay__scope-row">
          <div className="auto-parlay__scope" role="group" aria-label="场次范围">
            <button
              type="button"
              className={state.scope === 'today' ? 'is-active' : ''}
              aria-pressed={state.scope === 'today'}
              onClick={() => onScopeChange('today')}
            >
              今天
            </button>
            <button
              type="button"
              className={state.scope === 'all' ? 'is-active' : ''}
              aria-pressed={state.scope === 'all'}
              onClick={() => onScopeChange('all')}
            >
              跨天
            </button>
          </div>
          <span className="auto-parlay__scope-note">
            {data
              ? `在售 ${data.coverage.onSale} 场 · ${state.scope === 'today' ? '今天' : '全部'} ${data.coverage.inScope} 场 · 有赔率 ${data.coverage.withOdds} · 有伤停 ${data.coverage.withInjury} · 有近况 ${data.coverage.withHistory}`
              : '概率全部由服务端计算'}
          </span>
        </div>

        <div className={`auto-parlay__progress${state.running ? ' is-running' : ''}`} aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>

        {state.running && (
          <p className="auto-parlay__running">
            读库 → 赔率去水 → 反推 λ → 近况/伤停/进球修正 → 串关风控
          </p>
        )}

        <div className="auto-parlay__result">
          {state.running && (
            <div className="auto-parlay__skeleton" role="status" aria-live="polite" aria-label="推荐计算中">
              {[0, 1].map((index) => (
                <div className="auto-parlay__sk-plan" key={index} aria-hidden="true">
                  <div className="auto-parlay__sk-head">
                    <span />
                    <span />
                  </div>
                  <div className="auto-parlay__sk-stats">
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="auto-parlay__sk-leg">
                    <i />
                    <span />
                    <b />
                  </div>
                  <div className="auto-parlay__sk-leg">
                    <i />
                    <span />
                    <b />
                  </div>
                  <div className="auto-parlay__sk-foot">
                    <span />
                  </div>
                </div>
              ))}
            </div>
          )}

          {data?.plans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              candidates={data.candidates}
              extras={extrasByPlan[plan.id] ?? []}
              pickerOpen={pickerPlan === plan.id}
              onTogglePicker={() => setPickerPlan((current) => (current === plan.id ? null : plan.id))}
              onToggleCandidate={(candidate) => toggleCandidate(plan.id, candidate)}
              onApply={onApply}
            />
          ))}

          {data && !state.running && data.notes.length > 0 && (
            <ul className="auto-parlay__notes">
              {data.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}

          {data && !state.running && data.candidates.length > 0 && (
            <details className="auto-parlay__cands">
              <summary>全部候选（{data.candidates.length} 场）与被过滤原因</summary>
              <ul>
                {data.candidates.map((candidate) => (
                  <li key={candidate.matchId}>
                    <span className="auto-parlay__cand-match">
                      <strong>{candidate.matchNo}</strong> {candidate.teams}
                    </span>
                    <span className="auto-parlay__cand-pick">
                      {candidate.optionLabel} @{candidate.odd.toFixed(2)} · 融合 {percent(candidate.blendP)}
                    </span>
                    {candidate.passSafe || candidate.passAggressive ? (
                      <em className="is-on">已入方案</em>
                    ) : (
                      <em className="is-off">{candidate.rejectReason || '未达门槛'}</em>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {data &&
            !state.running &&
            data.candidates.some((candidate) => !candidate.passSafe && !candidate.passAggressive) && (
              <p className="auto-parlay__cand-hint">
                未达门槛的场次不会自动进方案；想串上它们，在上方方案卡里点「加入候选」手动补满 2/3 场，再应用投注。
              </p>
            )}

          {backtest && backtest.window.matches > 0 && (
            <section className="auto-parlay__backtest">
              <h3>
                同口径回测 · 近 {backtest.window.matches} 场
                {backtest.window.from ? `（${backtest.window.from} ~ ${backtest.window.to}）` : ''}
              </h3>
              <div className="auto-parlay__backtest-grid">
                <div>
                  <span>单场首选</span>
                  <b>{percent(backtest.singles.hitRate)}</b>
                  <em>
                    {backtest.singles.n} 注 · 回报 {(backtest.singles.roi * 100).toFixed(0)}%
                  </em>
                </div>
                <div>
                  <span>2串1 模拟</span>
                  <b>{percent(backtest.doubles.hitRate)}</b>
                  <em>
                    {backtest.doubles.n} 注 · 回报 {(backtest.doubles.roi * 100).toFixed(0)}%
                  </em>
                </div>
                <div>
                  <span>长赔（≥4）</span>
                  <b>{percent(backtest.longshot.hitRate)}</b>
                  <em>
                    {backtest.longshot.n} 注 · 回报 {(backtest.longshot.roi * 100).toFixed(0)}%
                  </em>
                </div>
              </div>
              <p className="auto-parlay__bands">
                赔率区间命中率：
                {backtest.bands.map((band) => (
                  <span key={band.label}>
                    {band.label} {band.n > 0 ? percent(band.hitRate) : '—'}
                  </span>
                ))}
              </p>
              <p className="auto-parlay__note">{backtest.note}</p>
            </section>
          )}

          {data && !state.running && (
            <p className="auto-parlay__disclaimer">
              风控上限：最多 3 场 · 总赔率 ≤ 8 · 单腿赔率 ≤ 3.3 · 2串1 命中率 ≥ 26%。
              达不到门槛就空着——高赔长串不是被忽略，是被这几条挡住了。
              推荐只是概率参考：庄家抽水让长期期望低于 1，别把它当成稳赚；单关的期望永远优于同场串关。
            </p>
          )}
        </div>

        <footer className="auto-parlay__actions">
          <span className="auto-parlay__actions-hint">概率由服务端计算 · 仅供参考，不构成投注建议</span>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
