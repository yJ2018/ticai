import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 常驻爬虫守护：daemon.mjs 退出就自动拉起。
 *
 * 2026-11-03 的教训：daemon 被一条未捕获的 ECONNRESET 带走后没有人重启它，
 * 数据整整停更一天。这里不碰抓取逻辑，只负责「退一个、拉一个」，
 * 子进程的 stdout/stderr 原样继承，日志还是同一份。
 *
 *   npm run crawl:supervised        前台常驻（Ctrl+C 停掉整组）
 *   后台运行见 apps/crawler/README.md「调度」一节
 */

const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const entry = resolve(repoRoot, 'apps/crawler/src/daemon.mjs')

/** 首次重启等 5 秒，连续崩溃则退避到 1 分钟，避免疯狂刷屏。 */
const MIN_DELAY_MS = 5_000
const MAX_DELAY_MS = 60_000
/** 连续跑满 10 分钟算稳住，下次挂了重新从 5 秒起算。 */
const STABLE_MS = 10 * 60_000

let child = null
let stopping = false
let delay = MIN_DELAY_MS
let restarts = 0
let restartTimer = null

function stamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

function start() {
  const startedAt = Date.now()
  child = spawn(process.execPath, [entry], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  })

  child.on('error', (error) => {
    console.error(`[supervisor] 启动爬虫失败：${error.message}`)
  })

  child.on('exit', (code, signal) => {
    child = null
    if (stopping) {
      process.exit(0)
    }

    const ranFor = Date.now() - startedAt
    if (ranFor >= STABLE_MS) {
      delay = MIN_DELAY_MS
    }

    const wait = delay
    delay = Math.min(delay * 2, MAX_DELAY_MS)
    restarts += 1

    console.error(
      `[supervisor] ${stamp()} 爬虫退出（code=${code ?? '-'} signal=${signal ?? '-'}，` +
        `运行 ${Math.round(ranFor / 1000)}s），${Math.round(wait / 1000)}s 后第 ${restarts} 次重启`,
    )

    restartTimer = setTimeout(start, wait)
  })
}

function shutdown(signal) {
  if (stopping) {
    return
  }
  stopping = true

  if (restartTimer) {
    clearTimeout(restartTimer)
  }

  console.log(`\n[supervisor] 收到 ${signal}，等待爬虫收尾…`)
  if (!child) {
    process.exit(0)
  }

  child.kill(signal)
  // daemon 收到信号后会等当前批次结束（上限 60s），这里再留 30s 余量
  setTimeout(() => {
    console.error('[supervisor] 爬虫超时未退出，强制结束')
    child?.kill('SIGKILL')
    process.exit(1)
  }, 90_000).unref()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal))
}

console.log(`[supervisor] ${stamp()} 已启动守护，子进程：${entry}`)
start()
