/**
 * API 基地址。
 *
 * 默认空字符串 = 同源（本地 dev 由 Vite 代理，生产由 Vercel rewrite）。
 * 前后端分开部署时在构建环境里设置 VITE_API_BASE，例如：
 *   VITE_API_BASE=https://ticai-api.vercel.app
 *
 * 注意：VITE_ 前缀的变量会打进浏览器 bundle，这里只能放域名，绝不能放密钥。
 */

const raw = import.meta.env.VITE_API_BASE ?? ''

export const API_BASE = String(raw).replace(/\/+$/, '')

export function apiUrl(path: string) {
  return `${API_BASE}${path}`
}
