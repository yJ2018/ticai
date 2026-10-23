import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { formatClock, isBettingOpen, msUntilWindowOpen } from './bet-window.mjs'
import { createConfig, loadEnv } from './config.mjs'
import { createPool } from './db.mjs'
import { msUntilNextDaily } from './daily-schedule.mjs'
import { crawlDetails } from './tasks/details.mjs'
import { expireStartedMatches } from './tasks/expire.mjs'
import { crawlHistory } from './tasks/history.mjs'
import { crawlLineupsBrowser } from './tasks/lineups-browser.mjs'
import { crawlMatches } from './tasks/matches.mjs'
import { crawlOfficialData, describeOfficialResult } from './tasks/official.mjs'

/**
 * 本地常驻爬虫：抓取在本机完成，写入云端数据库。
 *
 * 三条链路的合理频率差很多，用单一 cron 会互相拖累，所以分开调度：
 *   matches  5 分钟   —— 赔率变化快，但一轮要几十秒（跨境写库）
 *   history  30 分钟  —— 开奖一天一次
 *   details  60 分钟  —— 伤停/对战数据，7 个源，最贵
 *
 * 每条链路独立 setInterval + 运行锁：上一轮没跑完就跳过，不会堆积。
 */

const repoRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
loadEnv(repoRoot)

const config = createConfig()

if (!config.database.url) {
  console.error('缺少 DATABASE_URL：请在仓库根 .env 里配置云端数据库连接串')
  process.exit(1)
}

const pool = createPool(config.database)
const queued = new Set()
const busy = new Set()
let stopping = false

/** 整轮间隔（history / details），默认 3 小时。 */
const EVERY_MS = config.intervalMinutes * 60_000
/** 赔率单独提速，默认 30 分钟。 */
const MATCHES_MS = config.matchesMinutes * 60_000
/** 阵容赛前才公布，单独周期，默认 60 分钟。 */
const LINEUPS_MS = config.lineupsMinutes * 60_000

/** 串行队列：跨境写库延迟高，并发只会互相抢连接，排队反而更快。 */
let queue = Promise.resolve()

const TASKS = [
  {
    name: 'expire',
    // 纯本地状态收敛，不发任何请求，所以不受销售时段闸门限制
    gate: false,
    everyMs: MATCHES_MS,
    run: async () => {
      const summary = await expireStartedMatches({ pool })
      return `${summary.closed} 场已开赛 → 停售`
    },
  },
  {
    name: 'matches',
    // 非销售时段盘口不会变，抓了也是白跑
    gate: true,
    everyMs: MATCHES_MS,
    run: async () => {
      const summary = await crawlMatches({ pool, config })
      return `${summary.matches} 场 · 赔率变更 ${summary.changed} · 下架 ${summary.closed} · 跳过 ${summary.skipped}`
    },
  },
  {
    name: 'history',
    everyMs: EVERY_MS,
    run: async () => {
      const list = await crawlHistory({ pool, config })
      return list
        .map((item) => `${item.game}:${item.error ? `失败(${item.error})` : item.saved}`)
        .join(' · ')
    },
  },
  {
    name: 'details',
    gate: true,
    everyMs: EVERY_MS,
    run: async () => {
      // 覆盖全部在售比赛，而不是只抓最近 10 场：伤停越全，分析越准
      const summary = await crawlDetails({ pool, config, limit: config.detailsLimit })
      return `${summary.matches} 场 · 伤停 ${summary.injuries} · 比分 ${summary.results} · 失败 ${summary.failed}`
    },
  },
  {
    name: 'lineups',
    gate: config.lineupsGate,
    everyMs: LINEUPS_MS,
    run: async () => {
      const summary = await crawlLineupsBrowser({ pool, windowHours: 6, limit: 12 })
      return `${summary.matched} 场候选 · 入库 ${summary.found} · 球员 ${summary.players}`
    },
  },
  {
    name: 'official',
    // 每天定时预热，开盘前把官网数据刷一遍；不受销售时段限制
    gate: false,
    everyMs: 0,
    run: async () => describeOfficialResult(await crawlOfficialData({ pool, config })),
  },
]

function stamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

async function runTask(task) {
  if (stopping) {
    return
  }
  busy.add(task.name)
  const startedAt = Date.now()
  try {
    const detail = await task.run()
    console.log(
      `[${stamp()}] ${task.name.padEnd(8)} ok  ${detail}  (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`,
    )
  } catch (error) {
    console.error(
      `[${stamp()}] ${task.name.padEnd(8)} 失败 ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    busy.delete(task.name)
  }
}

/** 入队；同一任务已有排队项时跳过，避免堆积。 */
function enqueue(task) {
  if (stopping || queued.has(task.name)) {
    return
  }
  queued.add(task.name)
  queue = queue.then(async () => {
    try {
      await runTask(task)
    } finally {
      queued.delete(task.name)
    }
  })
}

const kickoffs = []
const intervals = []

/** 到点先过销售时段闸门；关盘就不入队，并排一个「开盘即补跑」的定时器。 */
const catchUps = new Map()

function tick(task) {
  if (stopping) {
    return
  }
  if (task.gate) {
    const status = isBettingOpen(new Date(), config)
    if (!status.open) {
      console.log(
        `[${stamp()}] ${task.name.padEnd(8)} 跳过：非销售时段 ${status.clock.label}` +
          `（销售 ${formatClock(status.window.start)}-${formatClock(status.window.end)}）`,
      )

      // 10:58 跳过、11:28 才轮到下一轮的话，开盘后半小时都是旧数据；
      // 这里按开盘时刻补一次，不算额外的抓取频率。
      if (!catchUps.has(task.name)) {
        const delay = msUntilWindowOpen(new Date(), config) + 5_000
        const timer = setTimeout(() => {
          catchUps.delete(task.name)
          tick(task)
        }, delay)
        catchUps.set(task.name, timer)
      }
      return
    }
  }
  enqueue(task)
}

TASKS.forEach((task, index) => {
  // everyMs = 0 的任务（每日预热）由独立定时器调度，不进周期循环
  if (!task.everyMs) {
    return
  }
  // 错开首次执行，避免几条链路同时打上游
  kickoffs.push(
    setTimeout(() => {
      tick(task)
      intervals.push(setInterval(() => tick(task), task.everyMs))
    }, index * 5_000),
  )
})

// 每日预热：北京时间 config.dailyHour:00 跑一轮「仅官方数据」
const dailyTask = TASKS.find((task) => task.name === 'official')
let dailyTimer = null

function scheduleDaily() {
  const delay = msUntilNextDaily(config.dailyHour, 0)
  console.log(
    `  每日预热: 每天 ${String(config.dailyHour).padStart(2, '0')}:00（北京时间，约 ${Math.round(delay / 60_000)} 分钟后）`,
  )
  dailyTimer = setTimeout(() => {
    enqueue(dailyTask)
    scheduleDaily()
  }, delay)
}

scheduleDaily()

console.log('─'.repeat(64))
console.log('ticai 本地爬虫已启动（抓取在本机，写入云端数据库）')
try {
  console.log(`  数据库 : ${new URL(config.database.url).host}`)
} catch {
  console.log('  数据库 : 连接串格式异常')
}
console.log(
  `  调度   : matches 每 ${config.matchesMinutes} 分钟 · lineups 每 ${config.lineupsMinutes} 分钟 · history/details 每 ${config.intervalMinutes} 分钟`,
)
console.log(`  销售时段: 平日 ${config.betWindowWeekday} · 周末 ${config.betWindowWeekend}（北京时间）`)
console.log('  退出   : Ctrl+C')
console.log('─'.repeat(64))

function shutdown(signal) {
  if (stopping) {
    return
  }
  stopping = true
  console.log(`\n[crawler] 收到 ${signal}，等待当前批次结束后退出…`)

  for (const handle of kickoffs) {
    clearTimeout(handle)
  }
  for (const handle of intervals) {
    clearInterval(handle)
  }
  if (dailyTimer) {
    clearTimeout(dailyTimer)
  }
  for (const timer of catchUps.values()) {
    clearTimeout(timer)
  }
  catchUps.clear()

  const deadline = Date.now() + 60_000
  const timer = setInterval(async () => {
    const idle = busy.size === 0 && queued.size === 0
    if (idle || Date.now() > deadline) {
      clearInterval(timer)
      await pool.end().catch(() => {})
      process.exit(0)
    }
  }, 500)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// 常驻进程不能因为一次未捕获的拒绝就静默退出：记录后继续跑，下一轮照常调度。
process.on('unhandledRejection', (reason) => {
  console.error('[crawler] 未处理的 Promise 拒绝：', reason instanceof Error ? reason.message : reason)
})
