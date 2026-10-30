export const SITE_URL = 'https://yujun426.online'
export const SITE_NAME = '体彩助手'

export const DEFAULT_DESCRIPTION =
  '体彩助手提供竞彩足球每日赛程、胜平负 / 让球 / 总进球 / 比分 / 半全场实时赔率、开奖结果与历史数据分析，支持保存投注方案并自动结算中奖。'

export type PageMeta = {
  title: string
  description: string
  /** 登录后 / 私有页面不收录 */
  noindex?: boolean
}

/** meta 的「纯数据」版本：服务端直接拼 HTML，客户端再写进 DOM */
export type ResolvedPageMeta = {
  title: string
  description: string
  canonical: string
  robots: string
}

const PAGE_META: Record<string, PageMeta> = {
  '/': { title: '竞彩足球赛程与实时赔率', description: DEFAULT_DESCRIPTION },
  '/results': {
    title: '竞彩足球开奖结果',
    description:
      '按比赛日查看竞彩足球开奖结果：胜平负、让球胜平负、总进球、比分、半全场的赛果与奖金，数据随官方开奖更新。',
  },
  '/odds-distribution': {
    title: '总进球赔率分布',
    description:
      '把已开奖比赛的总进球赔率从低到高排序，统计最低赔率、倒数第二低、第三低与最终中奖赔率的分布，不限时间回看赔率与赛果的关系。',
  },
  '/history': {
    title: '体彩开奖历史',
    description: '体彩开奖历史查询，按日期查看竞彩足球等玩法的开奖结果与派奖信息。',
  },
  '/history-analysis': {
    title: '竞彩历史数据分析',
    description: '基于历史开奖数据的竞彩分析：胜平负分布、比分频率、总进球走势，帮助理解赔率与赛果规律。',
  },
  '/math-trend-analysis': {
    title: '竞彩数学走势分析',
    description: '用数学方法看竞彩：赔率隐含概率、走势对比与冷热分布，辅助判断比赛走向。',
  },
  '/horoscope': {
    title: '星座运势',
    description: '每日星座运势与竞彩趣味参考，仅供娱乐。',
  },
  '/about': {
    title: '关于体彩助手',
    description: '体彩助手的产品说明、数据来源、使用方式与免责声明。',
  },
  '/login': { title: '登录', description: '登录体彩助手，保存投注方案、查看中奖记录。', noindex: true },
  '/account': { title: '我的账号', description: '账号信息、登录方式与微信绑定。', noindex: true },
  '/my-bets': { title: '我的投注', description: '查看保存的投注方案与中奖结算。', noindex: true },
  '/profile': { title: '个人资料', description: '个人资料设置。', noindex: true },
}

function upsertMeta(attr: 'name' | 'property', key: string, content: string) {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`)
  if (!element) {
    element = document.createElement('meta')
    element.setAttribute(attr, key)
    document.head.appendChild(element)
  }
  element.setAttribute('content', content)
}

function upsertLink(rel: string, href: string) {
  let element = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)
  if (!element) {
    element = document.createElement('link')
    element.setAttribute('rel', rel)
    document.head.appendChild(element)
  }
  element.setAttribute('href', href)
}

/**
 * 路由级 meta 的纯函数版本：服务端（src/ssr/html.ts）和客户端共用同一份规则，
 * 保证 SSR 出来的 <head> 与客户端接管后的完全一致。
 */
export function resolvePageMeta(pathname: string, override?: Partial<PageMeta>): ResolvedPageMeta {
  const meta: PageMeta = {
    ...(PAGE_META[pathname] ?? { title: '竞彩足球赛程与赔率', description: DEFAULT_DESCRIPTION }),
    ...override,
  }
  const title = meta.title.includes(SITE_NAME) ? meta.title : `${meta.title} · ${SITE_NAME}`
  const description = meta.description || DEFAULT_DESCRIPTION
  const canonical = `${SITE_URL}${pathname === '/' ? '/' : pathname}`

  return {
    title,
    description,
    canonical,
    robots: meta.noindex ? 'noindex,follow' : 'index,follow,max-image-preview:large',
  }
}

/**
 * 单页应用的路由级 meta：标题、描述、canonical、OG、robots。
 * 在 App 里按 pathname 调用，页面有更具体的信息（如比赛详情）时再用 override 覆盖。
 */
export function applyPageMeta(pathname: string, override?: Partial<PageMeta>) {
  if (typeof document === 'undefined') {
    return
  }

  const { title, description, canonical, robots } = resolvePageMeta(pathname, override)

  document.title = title
  upsertMeta('name', 'description', description)
  upsertMeta('name', 'robots', robots)
  upsertMeta('property', 'og:title', title)
  upsertMeta('property', 'og:description', description)
  upsertMeta('property', 'og:url', canonical)
  upsertMeta('name', 'twitter:title', title)
  upsertMeta('name', 'twitter:description', description)
  upsertLink('canonical', canonical)
}
