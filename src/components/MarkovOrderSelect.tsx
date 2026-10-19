import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

type MarkovOrderSelectProps = {
  value: number
  options: readonly number[]
  onChange: (value: number) => void
}

/**
 * 马尔科夫阶数下拉。
 *
 * 原生 <select> 展开后的 option 列表由操作系统渲染，CSS 无法统一（Windows Chrome/Edge
 * 尤其明显），所以这里用 button + listbox 自绘，保证和站内主题一致。
 */
export function MarkovOrderSelect({ value, options, onChange }: MarkovOrderSelectProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.indexOf(value)))
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()

  const selectedIndex = Math.max(0, options.indexOf(value))

  function openMenu() {
    setActiveIndex(selectedIndex)
    setOpen(true)
  }

  function closeMenu(restoreFocus = false) {
    setOpen(false)
    if (restoreFocus) {
      triggerRef.current?.focus({ preventScroll: true })
    }
  }

  function commit(nextValue: number) {
    onChange(nextValue)
    closeMenu(true)
  }

  useEffect(() => {
    if (open) {
      menuRef.current?.focus({ preventScroll: true })
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) {
        return
      }
      setOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }
    const option = menuRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    option?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!open) {
      if (
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'Enter' ||
        event.key === ' '
      ) {
        event.preventDefault()
        openMenu()
      }
      return
    }

    if (event.key === 'Tab') {
      setOpen(false)
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu(true)
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => (index + 1) % options.length)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => (index - 1 + options.length) % options.length)
      return
    }

    if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
      return
    }

    if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(options.length - 1)
      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      commit(options[activeIndex])
    }
  }

  return (
    <div className="history-analysis-page__order-wrap" ref={rootRef} onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={`history-analysis-page__order${open ? ' is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={`马尔科夫阶数，当前 ${value} 阶`}
        onClick={() => (open ? closeMenu() : openMenu())}
      >
        <span className="history-analysis-page__order-label">
          <span className="history-analysis-page__order-label-full">马尔科夫阶数</span>
          <span className="history-analysis-page__order-label-short">阶数</span>
        </span>
        <span className="history-analysis-page__order-value">{value} 阶</span>
        <svg
          className="history-analysis-page__order-chevron"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M3 4.5 6 7.5l3-3"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          ref={menuRef}
          id={listboxId}
          className="history-analysis-page__order-menu"
          role="listbox"
          tabIndex={-1}
          aria-label="马尔科夫阶数"
          aria-activedescendant={`${listboxId}-option-${activeIndex}`}
        >
          {options.map((option, index) => {
            const selected = option === value
            const active = index === activeIndex

            return (
              <div
                key={option}
                id={`${listboxId}-option-${index}`}
                data-index={index}
                role="option"
                aria-selected={selected}
                className={`history-analysis-page__order-option${active ? ' is-active' : ''}${
                  selected ? ' is-selected' : ''
                }`}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(option)}
              >
                <span>{option} 阶</span>
                {selected && (
                  <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path
                      d="M2.4 6.2 4.9 8.7l4.7-5.2"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
