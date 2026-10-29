import type { NextConfig } from 'next'

/**
 * `/api/**` 一律转到自有 API 项目：
 *   - 本地：默认 127.0.0.1:3001（npm run dev 会和 API 一起起）；
 *   - 线上：ticai-service 的 Vercel 域名，可用 API_PROXY_TARGET 覆盖。
 * 浏览器始终同源请求，不写死域名、也不走跨域。
 */
const apiProxyTarget =
  process.env.API_PROXY_TARGET ??
  (process.env.NODE_ENV === 'production'
    ? 'https://ticai-service.vercel.app'
    : 'http://127.0.0.1:3001')

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // 开发期用 127.0.0.1 打开时，Next 会把它当成跨域来源拦掉 dev 通道，
  // 表现为「页面能看但没 hydration」：数据不加载、点击变整页刷新。
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiProxyTarget}/api/:path*` }]
  },
}

export default nextConfig
