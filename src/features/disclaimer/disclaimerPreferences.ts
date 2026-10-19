const STORAGE_KEY_PREFIX = 'ticai.entertainment-disclaimer.hidden.v1'

/**
 * 进入这些页面时提示「仅供娱乐」。
 * 对应顶部导航红框区域：赛事投注 / 开奖历史 / 分析页面 / 数学走势。
 */
export const ENTERTAINMENT_DISCLAIMER_PATHS: readonly string[] = [
  '/',
  '/history',
  '/history-analysis',
  '/math-trend-analysis',
]

/** 每个路由使用独立 key，在一个页面勾选不会影响其它页面。 */
export function getEntertainmentDisclaimerKey(path: string): string {
  return `${STORAGE_KEY_PREFIX}:${path}`
}

/** 用户在当前页面勾选「以后本页不再提示」后，仅跳过该页面的弹层。 */
export function isEntertainmentDisclaimerHidden(path: string): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  try {
    return window.localStorage.getItem(getEntertainmentDisclaimerKey(path)) === '1'
  } catch {
    return false
  }
}

export function hideEntertainmentDisclaimerForever(path: string): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(getEntertainmentDisclaimerKey(path), '1')
  } catch {
    // 隐私模式或禁用存储时忽略：本次仍可关闭，只是下次还会提示
  }
}
