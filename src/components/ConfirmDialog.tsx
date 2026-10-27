import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

const EXIT_ANIMATION_MS = 160

export type ConfirmTone = 'default' | 'danger'

export type ConfirmOptions = {
  /** 弹窗标题 */
  title: string
  /** 正文说明，可传任意 ReactNode（比如加粗的方案名） */
  description?: ReactNode
  confirmText?: string
  cancelText?: string
  /** 异步执行时的按钮文案，默认「处理中…」 */
  pendingText?: string
  /** danger 用于删除 / 解绑这类不可恢复的操作 */
  tone?: ConfirmTone
  /**
   * 异步确认逻辑：传入后弹窗会保持打开并显示 loading，
   * resolve 后关闭并带回 true；reject 时把错误显示在弹窗里，可重试或取消。
   * 不传则点「确定」立即关闭，由调用方 await 返回值后自己处理。
   */
  onConfirm?: () => void | Promise<void>
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

type DialogState = ConfirmOptions & {
  id: number
  pending: boolean
  error: string
  closing: boolean
}

const ConfirmContext = createContext<ConfirmFn | null>(null)

/** 在任意组件里拿到 `confirm(options)`，替代 window.confirm */
export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext)
  if (!confirm) {
    throw new Error('useConfirm 必须在 <ConfirmDialogProvider> 内部使用')
  }
  return confirm
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return '操作失败，请稍后重试'
}

/**
 * 自定义确认弹窗（全局只渲染一个）。
 *
 * 相比 window.confirm 多了三件事：
 *   - 样式可控，跟方案弹层 / 免责弹层保持同一套圆角与缓动；
 *   - 支持异步 onConfirm：确认按钮进入 loading，失败时错误直接显示在弹窗内；
 *   - 支持 ESC / 点遮罩取消、焦点锁定与 Esc，弹窗打开时禁用页面滚动。
 */
export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const resolveRef = useRef<((value: boolean) => void) | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const dialogIdRef = useRef(0)
  const dialogRef = useRef<DialogState | null>(null)
  const pendingRef = useRef(false)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  dialogRef.current = dialog
  pendingRef.current = Boolean(dialog?.pending)

  const titleId = useId()
  const descId = useId()

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current)
      }
      resolveRef.current?.(false)
      resolveRef.current = null
    },
    [],
  )

  const close = useCallback((result: boolean) => {
    const current = dialogRef.current
    if (!current || current.closing) {
      return
    }
    const resolve = resolveRef.current
    resolveRef.current = null
    resolve?.(result)

    dialogRef.current = { ...current, closing: true }
    setDialog(dialogRef.current)
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
    }
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      dialogRef.current = null
      setDialog(null)
    }, EXIT_ANIMATION_MS)
  }, [])

  const confirm = useCallback<ConfirmFn>((options) => {
    // 上一个弹窗还悬着（理论上不会同时触发）时先按取消结算，避免 Promise 永远不落
    resolveRef.current?.(false)
    resolveRef.current = null

    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }

    dialogIdRef.current += 1
    const id = dialogIdRef.current
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
      const next: DialogState = { ...options, id, pending: false, error: '', closing: false }
      dialogRef.current = next
      setDialog(next)
    })
  }, [])

  const handleCancel = useCallback(() => {
    if (pendingRef.current) {
      return
    }
    close(false)
  }, [close])

  const handleConfirm = useCallback(async () => {
    const current = dialogRef.current
    if (!current || current.pending || current.closing) {
      return
    }
    if (!current.onConfirm) {
      close(true)
      return
    }

    const { id } = current
    dialogRef.current = { ...current, pending: true, error: '' }
    setDialog(dialogRef.current)

    try {
      await current.onConfirm()
      if (dialogRef.current?.id === id) {
        close(true)
      }
    } catch (error) {
      if (dialogRef.current?.id === id) {
        dialogRef.current = { ...dialogRef.current, pending: false, error: toErrorMessage(error) }
        setDialog(dialogRef.current)
      }
    }
  }, [close])

  // 打开时锁定滚动、聚焦卡片、Esc 取消、Tab 焦点循环
  useEffect(() => {
    if (!dialog || dialog.closing) {
      return
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // 焦点放在卡片上而不是按钮上，避免误按 Enter 直接执行删除
    const focusTimer = window.setTimeout(() => cardRef.current?.focus({ preventScroll: true }), 60)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!pendingRef.current) {
          close(false)
        }
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
        event.preventDefault()
        card.focus()
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
        ;(event.shiftKey ? last : first).focus()
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
      document.body.style.overflow = previousOverflow
      restoreFocusRef.current?.focus({ preventScroll: true })
      restoreFocusRef.current = null
    }
  }, [close, dialog?.closing, dialog?.id])

  if (!dialog || typeof document === 'undefined') {
    return <ConfirmContext.Provider value={confirm}>{children}</ConfirmContext.Provider>
  }

  const tone = dialog.tone ?? 'default'
  const pending = dialog.pending
  const confirmLabel = dialog.confirmText ?? '确定'

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {createPortal(
        <div
          className={`confirm-dialog${dialog.closing ? ' is-closing' : ''}`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              handleCancel()
            }
          }}
        >
          <div
            className="confirm-dialog__card"
            ref={cardRef}
            role="alertdialog"
            aria-modal="true"
            aria-busy={pending}
            aria-labelledby={titleId}
            aria-describedby={dialog.description ? descId : undefined}
            tabIndex={-1}
          >
            <div className="confirm-dialog__head">
              <span className={`confirm-dialog__badge is-${tone}`} aria-hidden="true">
                {tone === 'danger' ? (
                  <svg viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 4.15 20.4 18.9a1 1 0 0 1-.87 1.5H4.47a1 1 0 0 1-.87-1.5L12 4.15Z"
                      fill="currentColor"
                      opacity="0.12"
                    />
                    <path
                      d="M12 4.15 20.4 18.9a1 1 0 0 1-.87 1.5H4.47a1 1 0 0 1-.87-1.5L12 4.15Z"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinejoin="round"
                    />
                    <path d="M12 9.2v4.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    <circle cx="12" cy="16.3" r="1" fill="currentColor" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="8.2" fill="currentColor" opacity="0.12" />
                    <circle cx="12" cy="12" r="8.2" stroke="currentColor" strokeWidth="1.6" />
                    <path d="M12 11v4.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    <circle cx="12" cy="8.1" r="1" fill="currentColor" />
                  </svg>
                )}
              </span>
              <div className="confirm-dialog__heading">
                <h3 id={titleId}>{dialog.title}</h3>
                {dialog.description ? (
                  <p className="confirm-dialog__desc" id={descId}>
                    {dialog.description}
                  </p>
                ) : null}
              </div>
            </div>

            {dialog.error ? (
              <p className="confirm-dialog__error" role="alert">
                {dialog.error}
              </p>
            ) : null}

            <div className="confirm-dialog__actions">
              <button type="button" className="btn-ghost" disabled={pending} onClick={handleCancel}>
                {dialog.cancelText ?? '取消'}
              </button>
              <button
                type="button"
                className={`btn-primary confirm-dialog__confirm is-${tone}`}
                disabled={pending}
                onClick={() => void handleConfirm()}
              >
                {pending ? (
                  <>
                    <span className="confirm-dialog__spinner" aria-hidden="true" />
                    {dialog.pendingText ?? '处理中…'}
                  </>
                ) : (
                  confirmLabel
                )}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </ConfirmContext.Provider>
  )
}
