import { useLayoutEffect, useState } from 'react'

export type AiPanelPosition = {
  left: number
  top: number
  maxHeight: number
}

const PANEL_WIDTH = 430
const MOBILE_BREAKPOINT = 720

/**
 * 把 AI 浮层贴在触发按钮旁边：桌面端优先放在按钮左侧，
 * 空间不足时换到右侧或居中；移动端返回 null，由 CSS 切换为底部抽屉。
 */
export function useAiPanelPosition(anchor: HTMLElement | null) {
  const [position, setPosition] = useState<AiPanelPosition | null>(null)
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT,
  )

  useLayoutEffect(() => {
    if (!anchor) {
      setPosition(null)
      return
    }

    const target = anchor

    function update() {
      const mobile = window.innerWidth <= MOBILE_BREAKPOINT
      setIsMobile(mobile)
      if (mobile) {
        setPosition(null)
        return
      }

      const rect = target.getBoundingClientRect()
      const width = Math.min(PANEL_WIDTH, window.innerWidth - 24)

      let left = rect.left - width - 12
      if (left < 12) {
        left = rect.right + 12
      }
      if (left + width > window.innerWidth - 12) {
        left = Math.max(12, (window.innerWidth - width) / 2)
      }

      const estimatedHeight = Math.min(620, window.innerHeight - 24)
      const top = Math.max(
        12,
        Math.min(rect.top - 16, window.innerHeight - estimatedHeight - 12),
      )

      // 面板可能比预估更高，用实际 top 反推可用高度，避免底部超出视口
      setPosition({
        left,
        top,
        maxHeight: Math.max(320, window.innerHeight - top - 12),
      })
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor])

  return { position, isMobile }
}
