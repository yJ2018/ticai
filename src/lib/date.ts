/**
 * 北京时间的「今天」。
 *
 * 不用 `toLocaleDateString`：它依赖进程时区（Vercel 上是 UTC），
 * 这里用 UTC+8 偏移硬算，服务端和浏览器得到同一个日期。
 */
export function shanghaiToday(now: number = Date.now()): string {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}
