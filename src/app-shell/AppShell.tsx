'use client'

import { usePathname } from 'next/navigation'

import App from '../App'
import { ConfirmDialogProvider } from '../components/ConfirmDialog'
import type { SsrInitialData } from '../lib/initial-data'
import { matchAppRoute } from '../router/manifest'
import { InitialDataProvider } from '../ssr/initial-context'
import { seedInitialData } from '../ssr/seed'

/**
 * 客户端外壳（挂在根布局里，跨路由不卸载）。
 *
 * 服务端页面只做两件事：路径校验和 metadata；真正的布局、导航、Keep-Alive 都在这里。
 * 未登记的路径返回 null，把画面让给 `not-found.tsx`，避免 404 页外面套一层首页外壳。
 *
 * `initialData` 是服务端预取的首屏数据：通过 context 下发给页面（SSR 与 hydration 首帧
 * 都能读到），同时在首次挂载时灌进 store，供后续交互复用。
 */
export function AppShell({ initialData }: { initialData: SsrInitialData | null }) {
  const pathname = usePathname()

  if (!matchAppRoute(pathname)) {
    return null
  }

  // 首帧渲染时灌一次；函数内部有 once 守卫，重复调用无副作用
  seedInitialData(initialData)

  return (
    <InitialDataProvider value={initialData}>
      <ConfirmDialogProvider>
        <App />
      </ConfirmDialogProvider>
    </InitialDataProvider>
  )
}
