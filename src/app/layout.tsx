import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'

import { AppShell } from '../app-shell/AppShell'
import { DEFAULT_DESCRIPTION, SITE_NAME, SITE_URL } from '../features/seo/seo'
import { loadInitialData } from '../server/prefetch'
import '../styles/global.scss'

/**
 * 根布局。
 *
 * 站点级信息（图标、OG 兜底、JSON-LD）放这里；页面级 title/description/canonical
 * 由 `src/app/[[...slug]]/page.tsx` 的 generateMetadata 产出，两者用同一份
 * `resolvePageMeta()` 规则，保证服务端和客户端导航看到的是同一套。
 */

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: '体彩助手 · 竞彩足球赛程、赔率与开奖结果',
  description: DEFAULT_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: '竞彩足球,体彩,竞彩赛程,竞彩赔率,竞彩开奖结果,比分,总进球,半全场,胜平负,体彩助手',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48' },
      { url: '/favicon-32.png', type: 'image/png', sizes: '32x32' },
      { url: '/icon-192.png', type: 'image/png', sizes: '192x192' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    locale: 'zh_CN',
    images: [{ url: '/og-cover.png', width: 1200, height: 630, alt: '体彩助手 · 竞彩赛程与开奖结果' }],
  },
  twitter: {
    card: 'summary_large_image',
    images: ['/og-cover.png'],
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#2563eb',
}

const siteJsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: `${SITE_URL}/`,
      name: SITE_NAME,
      alternateName: ['ticai', '体彩助手 · 竞彩足球'],
      description: '竞彩足球赛程、赔率、开奖结果与历史数据分析工具。',
      inLanguage: 'zh-CN',
    },
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#organization`,
      name: SITE_NAME,
      url: `${SITE_URL}/`,
      logo: `${SITE_URL}/icon-512.png`,
    },
  ],
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // middleware 写入的当前路径：layout 拿不到 pathname，但首屏取数需要它
  const pathname = (await headers()).get('x-pathname') ?? '/'
  const initialData = await loadInitialData(pathname)

  return (
    <html lang="zh-CN">
      <body>
        <div id="app">
          {/*
            外壳必须放在 layout 里而不是 page 里：
            Next 在 `[[...slug]]` 的参数变化时会重新挂载 page 组件，
            外壳一旦挂在 page 上，Keep-Alive 缓存和页面输入状态每次导航都会丢。
            layout 跨路由不卸载，才撑得住 Keep-Alive。
          */}
          <AppShell initialData={initialData} />
          {children}
        </div>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd) }}
        />
        {/*
          Vercel Web Analytics，只在生产构建里挂载：
          - dev 下官方组件会去 va.vercel-scripts.com 拉 debug 脚本，本地不需要这条外网依赖；
          - 生产注入 /_vercel/insights/script.js，由 Vercel 在项目域名上提供，
            需要在项目 Dashboard 的 Analytics 里开启；未开启时只是控制台 404，不影响页面。
          - 切页由组件内部的 usePathname 感知（本站导航走 next/link），每次导航记一次 pageview；
            但本站只有 `[[...slug]]` 一个入口，route 维度会统一成 /[...slug]，看具体页面请用 path。
        */}
        {process.env.NODE_ENV === 'production' ? <Analytics /> : null}
      </body>
    </html>
  )
}
