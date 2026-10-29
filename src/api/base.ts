import { serverEnv } from './env'

/**
 * API 基地址。
 *
 * 浏览器：默认空字符串 = 同源。本地由 next.config.ts 的 rewrite 转到 3001，
 * 线上转到 ticai-service；需要直连时用 `NEXT_PUBLIC_API_BASE` 覆盖
 * （NEXT_PUBLIC_ 会打进客户端 bundle，只能放域名）。
 *
 * 服务端（Server Component / SSR）：Node 里没有「同源」，必须用绝对地址。
 * 优先 `SSR_API_ORIGIN`，没有就按环境取默认值——否则首屏预取会直接失败。
 */

const DEFAULT_SERVER_ORIGIN = 'https://ticai-service.vercel.app'
const DEV_SERVER_ORIGIN = 'http://127.0.0.1:3001'

function resolveBase(): string {
  const serverBase = serverEnv('SSR_API_ORIGIN')
  if (serverBase) {
    return serverBase
  }

  if (typeof window !== 'undefined') {
    return process.env.NEXT_PUBLIC_API_BASE ?? ''
  }

  return process.env.NODE_ENV === 'production' ? DEFAULT_SERVER_ORIGIN : DEV_SERVER_ORIGIN
}

export const API_BASE = resolveBase().replace(/\/+$/, '')

export function apiUrl(path: string) {
  return `${API_BASE}${path}`
}
