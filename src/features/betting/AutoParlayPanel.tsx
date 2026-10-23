import { useEffect } from 'react'
import { createPortal } from 'react-dom'

import { type ParlayLeg } from './parlayModel'
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
    return `${pct.toFixed(0)}%`
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

/**
 * 一键串关的分析过程面板：步骤条 + 进度 + 最终的三选与串关明细。
 * 数字都是模型真算出来的，动画只负责把阶段露出来。
 */
export function AutoParlayPanel({ state, poolLabel, onApply, onClose, onScopeChange }: AutoParlayPanelProps) {
  const open = state.poolType !== null

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

  const plan = state.plan
  const shortPlan = state.shortPlan
  const progress = plan ? 100 : state.total > 0 ? Math.round((state.processed / state.total) * 100) : 4

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
      <section className="auto-parlay__card" role="dialog" aria-modal="true" aria-label="一键串关分析">
        <header className="auto-parlay__head">
          <div>
            <p className="auto-parlay__eyebrow">一键串关 · {poolLabel}</p>
            <h2>
              {state.running
                ? '正在分析…'
                : plan
                  ? `${plan.legs.length}串1 方案`
                  : state.error || '分析完成'}
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
            {state.scope === 'today'
              ? `默认只串今天 · ${state.inScope} 场可用${state.excluded > 0 ? `，已排除跨天 ${state.excluded} 场` : ''}`
              : `已放开跨天 · 共 ${state.inScope} 场`}
          </span>
        </div>

        <div className="auto-parlay__progress" aria-hidden="true">
          <span style={{ width: `${Math.max(4, progress)}%` }} />
        </div>

        <ol className="auto-parlay__steps">
          {state.steps.map((step, index) => (
            <li key={step.key} className={`is-${step.status}`}>
              <i aria-hidden="true">
                {step.status === 'done' ? '✓' : step.status === 'active' ? <span className="auto-parlay__dot" /> : index + 1}
              </i>
              <span>{step.label}</span>
              <em>{step.detail}</em>
            </li>
          ))}
        </ol>

        {state.running && (
          <p className="auto-parlay__running">
            已分析 <b>{state.processed}</b> / {state.total || '—'} 场 · 模型依据：1X2 反推 λ → 泊松分布 → EV
          </p>
        )}

        {plan && (
          <div className="auto-parlay__result">
            <div className="auto-parlay__summary">
              <div>
                <span>总赔率</span>
                <b>{plan.totalOdd.toFixed(2)}</b>
              </div>
              <div>
                <span>模型命中率</span>
                <b>{percent(plan.hitProb)}</b>
              </div>
              <div>
                <span>期望回报</span>
                <b className={plan.expectedReturn >= 1 ? 'is-good' : 'is-bad'}>
                  {plan.expectedReturn.toFixed(2)}×
                </b>
              </div>
              <div>
                <span>风险</span>
                <b className={`auto-parlay__risk is-${plan.risk}`}>{plan.risk}</b>
              </div>
            </div>

            <div className="auto-parlay__table-wrap">
              <table className="auto-parlay__table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>场次 / 对阵</th>
                    <th>选择</th>
                    <th>赔率</th>
                    <th>模型概率</th>
                    <th>EV</th>
                    <th>置信度</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.legs.map((leg, index) => (
                    <tr key={leg.matchId}>
                      <td className="is-index">{index + 1}</td>
                      <td className="is-match">
                        <strong>{leg.matchNo}</strong>
                        <span>{leg.teams}</span>
                      </td>
                      <td>
                        <em className={`auto-parlay__role is-${leg.role === '首选' ? 'primary' : 'steady'}`}>
                          {leg.role}
                        </em>
                        {leg.pick.label}
                      </td>
                      <td className="is-num">{leg.pick.odd.toFixed(2)}</td>
                      <td className="is-num">{percent(leg.pick.modelP)}</td>
                      <td className={`is-num ${leg.ev >= 0 ? 'is-good' : 'is-bad'}`}>{signedPercent(leg.ev)}</td>
                      <td className="is-num">{CONFIDENCE_LABEL[leg.confidence]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="auto-parlay__legs">
              {plan.legs.map((leg) => (
                <li key={`card-${leg.matchId}`}>
                  <div className="auto-parlay__leg-head">
                    <strong>{leg.matchNo}</strong>
                    <span>{leg.teams}</span>
                  </div>
                  <div className="auto-parlay__leg-meta">
                    <em className={`auto-parlay__role is-${leg.role === '首选' ? 'primary' : 'steady'}`}>
                      {leg.role}
                    </em>
                    <b>{leg.pick.label}</b>
                    <span>赔率 {leg.pick.odd.toFixed(2)}</span>
                    <span>概率 {percent(leg.pick.modelP)}</span>
                    <span className={leg.ev >= 0 ? 'is-good' : 'is-bad'}>{signedPercent(leg.ev)}</span>
                  </div>
                </li>
              ))}
            </ul>

            <p className="auto-parlay__note">
              {plan.note} 共 {state.analyzed} 场参与建模，按置信度与 EV 取前 {plan.legs.length} 场；
              赔率来自竞彩官方，伤停/天气未纳入，结论只作概率参考。
            </p>

            {shortPlan && (
              <div className="auto-parlay__alt">
                <span>
                  负期望时可缩短：{shortPlan.legs.length}串1 · 总赔率 {shortPlan.totalOdd.toFixed(2)} ·
                  命中率 {percent(shortPlan.hitProb)} · 期望 {shortPlan.expectedReturn.toFixed(2)}×
                </span>
                <button type="button" onClick={() => onApply(shortPlan.legs)}>
                  改用 {shortPlan.legs.length}串1
                </button>
              </div>
            )}

            <footer className="auto-parlay__actions">
              <button type="button" className="is-primary" onClick={() => onApply(plan.legs)}>
                应用到投注单
              </button>
              <button type="button" onClick={onClose}>
                取消
              </button>
            </footer>
          </div>
        )}

        {!plan && !state.running && state.error && (
          <footer className="auto-parlay__actions">
            <button type="button" onClick={onClose}>
              关闭
            </button>
          </footer>
        )}
      </section>
    </div>,
    document.body,
  )
}
