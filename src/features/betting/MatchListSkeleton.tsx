import { useLayoutEffect, useRef, useState } from 'react'
import { type MatchPoolType } from '../../service/matchService'

type MatchListSkeletonProps = {
  activePool: MatchPoolType
}

type SkeletonShape = {
  columns: number
  rows: number
  showMixedToggle?: boolean
}

const SKELETON_SHAPES: Record<MatchPoolType, SkeletonShape> = {
  had: { columns: 3, rows: 2 },
  crs: { columns: 5, rows: 3 },
  ttg: { columns: 4, rows: 2 },
  hafu: { columns: 3, rows: 3 },
  mixed: { columns: 3, rows: 1, showMixedToggle: true },
}

const MIN_CARD_COUNT = 4
const MAX_CARD_COUNT = 12

/** 首屏 / 切换玩法时的赛事列表骨架，尺寸与真实赔率卡片保持一致，减少加载跳动。 */
export function MatchListSkeleton({ activePool }: MatchListSkeletonProps) {
  const shape = SKELETON_SHAPES[activePool]
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [cardCount, setCardCount] = useState(MIN_CARD_COUNT)

  // 首屏内容区高度随窗口变化，按「可视高度 / 单张骨架高度」补足卡片，
  // 让加载态正好铺满一屏，而不是固定几张卡片下面留一大片空白。
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) {
      return
    }

    const content = root.closest('.home-page__content') as HTMLElement | null
    if (!content) {
      return
    }
    const contentElement = content

    let frame = 0
    let disposed = false

    function measure() {
      frame = 0
      if (disposed) {
        return
      }

      const card = root?.querySelector('.match-skeleton__card') as HTMLElement | null
      const list = root?.querySelector('.match-skeleton__list') as HTMLElement | null
      if (!card || !list) {
        return
      }

      const cardHeight = card.getBoundingClientRect().height
      if (cardHeight <= 0) {
        return
      }

      const contentStyle = window.getComputedStyle(contentElement)
      const verticalPadding =
        (Number.parseFloat(contentStyle.paddingTop) || 0) +
        (Number.parseFloat(contentStyle.paddingBottom) || 0)
      const availableHeight = Math.max(0, contentElement.clientHeight - verticalPadding)
      const listStyle = window.getComputedStyle(list)
      const gap = Number.parseFloat(listStyle.rowGap || listStyle.gap) || 0
      const nextCount = Math.min(
        MAX_CARD_COUNT,
        Math.max(MIN_CARD_COUNT, Math.ceil((availableHeight + gap) / (cardHeight + gap))),
      )

      setCardCount((previous) => (previous === nextCount ? previous : nextCount))
    }

    function scheduleMeasure() {
      if (disposed || frame) {
        return
      }
      frame = window.requestAnimationFrame(measure)
    }

    measure()
    const observer = new ResizeObserver(scheduleMeasure)
    observer.observe(contentElement)
    window.addEventListener('resize', scheduleMeasure)
    void document.fonts?.ready.then(scheduleMeasure).catch(() => undefined)

    return () => {
      disposed = true
      observer.disconnect()
      window.removeEventListener('resize', scheduleMeasure)
      if (frame) {
        window.cancelAnimationFrame(frame)
      }
    }
  }, [activePool])

  return (
    <div className="match-skeleton" role="status" aria-live="polite" aria-busy="true" ref={rootRef}>
      <span className="match-skeleton__sr">正在加载比赛数据…</span>
      <ul className="home-page__list match-skeleton__list" aria-hidden="true">
        {Array.from({ length: cardCount }, (_, cardIndex) => (
          <li key={cardIndex} className="is-option-layout">
            <div className={`pool-card pool-card--${activePool} match-skeleton__card`}>
              <div className="match-skeleton__head">
                <div className="match-skeleton__issue">
                  <span className="match-skeleton__line match-skeleton__line--match-no" />
                  <span className="match-skeleton__line match-skeleton__line--kickoff" />
                </div>
                <div className="match-skeleton__main">
                  <span className="match-skeleton__line match-skeleton__line--league" />
                  <span className="match-skeleton__line match-skeleton__line--teams" />
                </div>
                <span className="match-skeleton__ai" />
              </div>

              <div className="pool-card__odds-wrap">
                {Array.from({ length: shape.rows }, (_, rowIndex) => (
                  <div
                    key={rowIndex}
                    className="match-skeleton__odds"
                    style={{ gridTemplateColumns: `repeat(${shape.columns}, minmax(0, 1fr))` }}
                  >
                    {Array.from({ length: shape.columns }, (_, columnIndex) => (
                      <span
                        key={columnIndex}
                        className="match-skeleton__odd"
                        style={{ animationDelay: `${(rowIndex + columnIndex) * 45}ms` }}
                      />
                    ))}
                  </div>
                ))}
                {shape.showMixedToggle && (
                  <div className="match-skeleton__toggle-wrap">
                    <span className="match-skeleton__line match-skeleton__line--toggle" />
                  </div>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
