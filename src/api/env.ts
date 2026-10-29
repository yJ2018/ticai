type NodeProcess = { env?: Record<string, string | undefined> }

/**
 * 读取 Node 端环境变量。
 *
 * 浏览器里 `process` 不存在，恒返回 undefined；这样同一份前端代码
 * 既能在浏览器里被 Vite 静态替换，也能在 SSR 函数里读运行时配置。
 * 注意：只允许读「域名 / 开关」这类可以出现在产物里的配置，绝不要读密钥。
 */
export function serverEnv(key: string): string | undefined {
  const proc = (globalThis as { process?: NodeProcess }).process
  return proc?.env?.[key]
}
