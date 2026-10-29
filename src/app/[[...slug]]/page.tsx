import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { resolvePageMeta } from '../../features/seo/seo'
import { matchAppRoute } from '../../router/manifest'
import { normalizePathname } from '../../router/match'

/**
 * 全站唯一路由入口（可选 catch-all）。
 *
 * 这里只做服务端该做的事：路径是否存在、404、每页的 title/canonical。
 * 页面内容不在这里渲染——外壳在 `src/app/layout.tsx` 里（跨路由不卸载），
 * 否则 Keep-Alive 每次导航都会丢状态。
 */

type PageProps = {
  params: Promise<{ slug?: string[] }>
}

/** 每页都要取实时数据，不做构建期静态化 */
export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const pathname = toPathname(await params)
  const matched = matchAppRoute(pathname)

  if (!matched) {
    return { title: '页面不存在 · 体彩助手', robots: { index: false, follow: false } }
  }

  const meta = resolvePageMeta(pathname)
  return {
    title: meta.title,
    description: meta.description,
    alternates: { canonical: meta.canonical },
    robots: meta.robots,
    openGraph: {
      title: meta.title,
      description: meta.description,
      url: meta.canonical,
      images: [{ url: '/og-cover.png', width: 1200, height: 630, alt: '体彩助手 · 竞彩赛程与开奖结果' }],
    },
    twitter: {
      card: 'summary_large_image',
      title: meta.title,
      description: meta.description,
      images: ['/og-cover.png'],
    },
  }
}

export default async function Page({ params }: PageProps) {
  const pathname = toPathname(await params)

  // 未知路径给真正的 404（不再是「渲染首页 + 200」的软 404）
  if (!matchAppRoute(pathname)) {
    notFound()
  }

  return null
}

function toPathname(params: { slug?: string[] }) {
  return normalizePathname(`/${(params.slug ?? []).join('/')}`)
}
