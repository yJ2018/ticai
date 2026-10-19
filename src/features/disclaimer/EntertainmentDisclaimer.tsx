import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const EXIT_ANIMATION_MS = 220

type EntertainmentDisclaimerProps = {
  open: boolean
  /** hideForever 为 true 时，调用方负责把「不再提示」写入本地存储 */
  onDismiss: (hideForever: boolean) => void
}

/**
 * 进入赛事 / 分析类页面时的「仅供娱乐」免责提示。
 * 勾选「以后不再提示」并关闭后，由调用方持久化，之后不再弹出。
 */
export function EntertainmentDisclaimer({ open, onDismiss }: EntertainmentDisclaimerProps) {
  const [mounted, setMounted] = useState(open)
  const [hideForever, setHideForever] = useState(false)
  const hideForeverRef = useRef(false)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  // 每次重新打开都从未勾选开始，避免上一次的临时勾选被保留
  useEffect(() => {
    if (!open) {
      return
    }
    hideForeverRef.current = false
    setHideForever(false)
  }, [open])

  // 保留挂载到退场动画结束，关闭时才能看到淡出
  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    if (!mounted) {
      return
    }
    const timer = window.setTimeout(() => setMounted(false), EXIT_ANIMATION_MS)
    return () => window.clearTimeout(timer)
  }, [open, mounted])

  useEffect(() => {
    if (!mounted || typeof document === 'undefined') {
      return
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [mounted])

  const dismiss = useCallback(() => {
    onDismiss(hideForeverRef.current)
  }, [onDismiss])

  useEffect(() => {
    if (!open || typeof document === 'undefined') {
      return
    }

    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // 焦点放在对话框本身，避免打开时按钮就带一圈焦点描边，看起来像双边框
    const focusTimer = window.setTimeout(() => cardRef.current?.focus({ preventScroll: true }), 80)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        dismiss()
        return
      }
      if (event.key !== 'Tab') {
        return
      }

      const card = cardRef.current
      if (!card) {
        return
      }
      const focusables = Array.from(
        card.querySelectorAll<HTMLElement>('button, input, [href], [tabindex]:not([tabindex="-1"])'),
      ).filter((element) => !element.hasAttribute('disabled'))
      if (focusables.length === 0) {
        return
      }

      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (!card.contains(active)) {
        event.preventDefault()
        first.focus()
        return
      }
      if (active === card) {
        event.preventDefault()
        const target = event.shiftKey ? last : first
        target.focus()
        return
      }
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', handleKeyDown)
      restoreFocusRef.current?.focus({ preventScroll: true })
      restoreFocusRef.current = null
    }
  }, [open, dismiss])

  if (!mounted || typeof document === 'undefined') {
    return null
  }

  return createPortal(
    <div
      className={`entertainment-disclaimer${open ? ' is-open' : ''}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          dismiss()
        }
      }}
    >
      <div
        className="entertainment-disclaimer__card"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-labelledby="entertainment-disclaimer-title"
        aria-describedby="entertainment-disclaimer-desc entertainment-disclaimer-note"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="entertainment-disclaimer__head">
          <span className="entertainment-disclaimer__badge" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path
                d="M12 3 4.8 6v5.3c0 4.2 3 8 7.2 9.2 4.2-1.2 7.2-5 7.2-9.2V6L12 3Z"
                fill="currentColor"
                opacity="0.14"
              />
              <path
                d="M12 3 4.8 6v5.3c0 4.2 3 8 7.2 9.2 4.2-1.2 7.2-5 7.2-9.2V6L12 3Z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
              <path d="M12 8.1v4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <circle cx="12" cy="15.9" r="1" fill="currentColor" />
            </svg>
          </span>
          <div className="entertainment-disclaimer__heading">
            <p className="entertainment-disclaimer__eyebrow">温馨提示</p>
            <h3 id="entertainment-disclaimer-title">仅供娱乐</h3>
          </div>
        </div>

        <p className="entertainment-disclaimer__desc" id="entertainment-disclaimer-desc">
          本页赛事数据、走势分析与推荐内容仅供娱乐参考，不构成任何投注建议，也不承诺收益。
        </p>

        <p className="entertainment-disclaimer__note" id="entertainment-disclaimer-note">
          彩票有风险，请理性参与、量力而行。
          <br />
          未满18周岁请勿购买彩票。
        </p>

        <label className="entertainment-disclaimer__check">
          <input
            type="checkbox"
            checked={hideForever}
            onChange={(event) => {
              const checked = event.target.checked
              hideForeverRef.current = checked
              setHideForever(checked)
            }}
          />
          <span className="entertainment-disclaimer__check-box" aria-hidden="true">
            <svg viewBox="0 0 12 12">
              <path d="M2.4 6.2 4.9 8.7l4.7-5.2" />
            </svg>
          </span>
          <span className="entertainment-disclaimer__check-text">以后本页不再提示</span>
        </label>

        <button type="button" className="entertainment-disclaimer__confirm" onClick={dismiss}>
          我已知悉
        </button>
      </div>
    </div>,
    document.body,
  )
}
