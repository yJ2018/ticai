import { createPortal } from 'react-dom'
import { type RefObject } from 'react'
import { type PlanEntry } from './betSlipMath'

type PlanModalProps = {
  mounted: boolean
  open: boolean
  passSummaryText: string
  entries: PlanEntry[]
  isCapturing: boolean
  onCapture: () => void
  onClose: () => void
  layerRef: RefObject<HTMLDivElement | null>
}

/** 「查看方案」弹层：列出已选赛事与过关方式，并支持整层截图 */
export function PlanModal({
  mounted,
  open,
  passSummaryText,
  entries,
  isCapturing,
  onCapture,
  onClose,
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
            <span className="plan-modal__eyebrow">当前过关方式</span>
            <h3 id="plan-modal-title">{passSummaryText || '未选择过关'}</h3>
          </div>
          <div className="plan-modal__head-actions">
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
      </div>
    </div>,
    document.body,
  )
}
