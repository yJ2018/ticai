import { useSyncExternalStore } from 'react'

/**
 * 是否窄屏（H5）。
 *
 * 用 matchMedia 而不是读一次 innerWidth：旋屏、拖窗口、浏览器缩放都要能实时切换。
 * 断点取 47.99rem（≈768px），和 global.scss 里已有的 48rem 媒体查询对齐。
 */
const QUERY = '(max-width: 47.99rem)'

function subscribe(callback: () => void) {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener('change', callback)
  return () => mql.removeEventListener('change', callback)
}

function getSnapshot() {
  return window.matchMedia(QUERY).matches
}

export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
