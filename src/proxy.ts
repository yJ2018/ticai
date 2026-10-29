import { NextResponse, type NextRequest } from 'next/server'

/**
 * Next 16 的 proxy（原 middleware）：把当前路径写进请求头，供根布局读取。
 *
 * 为什么需要：页面外壳挂在 `layout.tsx`（Keep-Alive 要求跨路由不卸载），
 * 而 App Router 的 layout 拿不到 pathname；服务端要在 layout 里预取首页数据，
 * 就必须知道「这次请求的是哪一页」。
 *
 * 只对页面路由生效：`_next`、`/api`、带扩展名的静态资源都不经过这里。
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers)
  headers.set('x-pathname', request.nextUrl.pathname)
  return NextResponse.next({ request: { headers } })
}

export default proxy

export const config = {
  matcher: ['/((?!_next/|api/|.*\\..*).*)'],
}
