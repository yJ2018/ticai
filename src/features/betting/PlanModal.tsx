import { createPortal } from 'react-dom'
import { type RefObject } from 'react'
import { formatMoney, type PlanEntry } from './betSlipMath'

type PlanModalProps = {
  mounted: boolean
  open: boolean
  passSummaryText: string
  poolLabel: string
  multiple: number
  betAmount: number
  maxBonus: number
  entries: PlanEntry[]
  isCapturing: boolean
  onCapture: () => void
  onClose: () => void
  onAnalyze: (anchor: HTMLButtonElement) => void
  isAiActive: boolean
  layerRef: RefObject<HTMLDivElement | null>
}

/** 「查看方案」弹层：列出已选赛事与过关方式，并支持整层截图 / 方案级 AI 分析 */
export function PlanModal({
  mounted,
  open,
  passSummaryText,
  poolLabel,
  multiple,
  betAmount,
  maxBonus,
  entries,
  isCapturing,
  onCapture,
  onClose,
  onAnalyze,
  isAiActive,
  layerRef,
}: PlanModalProps) {
  if (!mounted || typeof document === 'undefined') {
    return null
  }

  return createPortal(
    <div
      className={`plan-modal ${open ? 'is-open' : ''}`}
      ref={layerRef}
      onClick={onClose}
      onPointerDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <div
        className="plan-modal__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-modal-title"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="plan-modal__head">
          <div>
            <span className="plan-modal__eyebrow" data-pool-label={poolLabel || '未知玩法'}>
              当前过关方式
            </span>
            <h3 id="plan-modal-title">{passSummaryText || '未选择过关'}</h3>
          </div>
          <div className="plan-modal__head-actions">
            <button
              type="button"
              className={`plan-modal__ai ${isAiActive ? 'is-active' : ''}`}
              onClick={(event) => onAnalyze(event.currentTarget)}
              disabled={entries.length === 0}
              aria-expanded={isAiActive}
              aria-label={isAiActive ? '收起 AI 串关分析' : 'AI 分析这个串关'}
              title={isAiActive ? '收起 AI 分析' : '让 AI 分析本方案的全部场次'}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path
                  d="M12 2.6l1.9 5.5 5.5 1.9-5.5 1.9L12 17.4l-1.9-5.5L4.6 10l5.5-1.9L12 2.6z"
                  fill="currentColor"
                />
                <path
                  d="M18.6 15.4l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z"
                  fill="currentColor"
                  opacity="0.75"
                />
              </svg>
              <span className="plan-modal__ai-label">AI分析</span>
            </button>
            <button
              type="button"
              className={`plan-modal__capture ${isCapturing ? 'is-loading' : ''}`}
              onClick={onCapture}
              disabled={isCapturing}
              aria-label={isCapturing ? '截图中' : '获取快照'}
              title={isCapturing ? '截图中' : '获取快照'}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8.5 6.5 10 4.5h4l1.5 2H18a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3h2.5Zm3.5 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z" />
              </svg>
            </button>
            <button type="button" className="plan-modal__close" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
        <ul className="plan-modal__list">
          {entries.map((entry) => (
            <li key={entry.id} className="plan-modal__item">
              <div className="plan-modal__item-head">
                <strong>
                  {entry.order}. {entry.matchNo} {entry.teams}
                </strong>
                <span>{entry.kickoffTime}</span>
              </div>
              <div className="plan-modal__options">
                {entry.selectedOptions.map((option) => (
                  <span key={`${entry.id}-${option.label}-${option.value}`} className="plan-modal__option-chip">
                    {option.label}
                    {option.value ? ` ${option.value}` : ''}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
        <div className="plan-modal__meta" hidden>
          <span className="plan-modal__meta-item">
            倍数 <strong>{multiple}倍</strong>
          </span>
          <span className="plan-modal__meta-item">
            投注金额 <strong>{formatMoney(betAmount)} 元</strong>
          </span>
          <span className="plan-modal__meta-item">
            理论最高奖金 <strong>{formatMoney(maxBonus)} 元</strong>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
