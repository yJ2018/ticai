import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createConfig, loadEnv } from './config.mjs'
import { createPool } from './db.mjs'
import { sleep } from './http.mjs'
import { crawlDetails } from './tasks/details.mjs'
import { expireStartedMatches } from './tasks/expire.mjs'
import { crawlHistory } from './tasks/history.mjs'
import { importLineups } from './tasks/lineups.mjs'
import { crawlLineupsBrowser, dumpLineupPage } from './tasks/lineups-browser.mjs'
import { crawlMatches } from './tasks/matches.mjs'

/**
 * 爬虫入口。
 *
 *   node src/index.mjs matches                 抓一次在售赛程与赔率
 *   node src/index.mjs history                 抓四个彩种的最新一页
 *   node src/index.mjs history --backfill      逐页回灌全部历史
 *   node src/index.mjs all --every=60          循环执行（默认只跑一次）
 *
 * 与主应用完全隔离：独立 package.json、独立进程、只通过数据库交汇。
 */

const repoRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
loadEnv(repoRoot)

const config = createConfig()
const args = process.argv.slice(2)
const flags = args.filter((arg) => arg.startsWith('--'))
const positional = args.filter((arg) => !arg.startsWith('--'))
const command = positional[0] ?? 'all'

const hasFlag = (name) => flags.includes(`--${name}`)
const flagValue = (name, fallback) => {
  const hit = flags.find((item) => item.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const USAGE = `
ticai crawler

  node src/index.mjs matches [--every=60]
  node src/index.mjs history [--backfill] [--pages=N] [--every=600]
  node src/index.mjs details [--full] [--limit=10] [--match=2042155] [--every=600]
  node src/index.mjs lineups --file=lineups.json [--dry]
  node src/index.mjs lineups-browser --fid=1502981 [--click=阵容] [--mobile]
  node src/index.mjs expire
  node src/index.mjs all [--every=60]

命令：
  matches   在售赛程 + 赔率，按内容 hash 去重写入快照
  history   四个彩种开奖；--backfill 逐页回灌
  details   对战数据：伤停 + 赛果（--full 抓全部 7 个源）
  lineups   导入阵容（JSON），--dry 只预演不落库
  lineups-browser  用 Playwright 打开数据站，dump 页面与网络响应（探测阵容来源）
  expire    本地状态收敛：已开赛的比赛标为停售（不发请求）
  all       两者都跑（不含 details，它太贵）

说明：
  每轮之间至少间隔 CRAWL_DELAY_MS，别把体彩当自家接口打。
  抓取结果写入 crawl_run，/api/health 靠它判断数据新鲜度。
`.trim()

if (hasFlag('help') || command === 'help') {
  console.log(USAGE)
  process.exit(0)
}

if (!['matches', 'history', 'details', 'lineups', 'lineups-browser', 'expire', 'all'].includes(command)) {
  console.error(`未知命令：${command}\n\n${USAGE}`)
  process.exit(1)
}

// 浏览器探测模式不需要数据库
if (!config.database.url && command !== 'lineups-browser') {
  console.error('缺少 DATABASE_URL，请在仓库根 .env 或 apps/crawler/.env 里配置')
  process.exit(1)
}

const everySeconds = Number(flagValue('every', '0')) || 0
const backfill = hasFlag('backfill')
const pagesArg = Number(flagValue('pages', '0')) || undefined

let stopping = false

async function runOnce() {
  const startedAt = Date.now()

  if (command === 'matches' || command === 'all') {
    const summary = await crawlMatches({ pool, config })
    console.log(
      `[matches] ${summary.matches} 场 · 赔率变更 ${summary.changed} · 新下架 ${summary.closed} · 跳过 ${summary.skipped}`,
    )
  }

  if (command === 'details') {
    const summary = await crawlDetails({
      pool,
      config,
      limit: Number(flagValue('limit', '10')) || 10,
      full: hasFlag('full'),
      matchIds: (flagValue('match', '') || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    })
    console.log(
      `[details] ${summary.matches} 场 · ${summary.requests} 次请求 · 比分更新 ${summary.results} · 伤停 ${summary.injuries} · 失败 ${summary.failed}`,
    )
  }

  if (command === 'lineups-browser') {
    if (hasFlag('run')) {
      const summary = await crawlLineupsBrowser({
        pool,
        windowHours: Number(flagValue('window', '6')) || 6,
        limit: Number(flagValue('limit', '15')) || 15,
        dryRun: hasFlag('dry'),
      })
      console.log(
        `[lineups] ${summary.matched} 场候选 · 入库 ${summary.found} · 跳过 ${summary.skipped} · 球员 ${summary.players}` +
          (summary.dryRun ? '（预演未落库）' : ''),
      )
      return
    }

    const fid = flagValue('fid', '')
    const url = flagValue('url', '') || (fid ? `https://live.500.com/detail.php?fid=${fid}` : '')
    if (!url) {
      throw new Error('缺少 --fid=<500.com 比赛 id> / --url=<页面地址>，或者用 --run 直接抓')
    }
    const result = await dumpLineupPage({
      url,
      outDir: flagValue('out', '.tmp/lineup-dump'),
      waitMs: Number(flagValue('wait', '8000')) || 8000,
      clickText: flagValue('click', ''),
      mobile: hasFlag('mobile'),
    })
    console.log(
      `[lineups-browser] DOM ${result.textLength} 字符 · 响应 ${result.captured} 条 · 候选 ${result.candidates} 处`,
    )
  }

  if (command === 'lineups') {
    const file = flagValue('file', '')
    if (!file) {
      throw new Error('缺少 --file=<阵容 JSON 路径>')
    }
    const summary = await importLineups({ pool, file, dryRun: hasFlag('dry') })
    console.log(
      `[lineups] ${summary.matches} 场 · ${summary.players} 名球员 · 来源 ${summary.source}` +
        (summary.dryRun ? ' · 预演（已回滚）' : ''),
    )
  }

  if (command === 'expire') {
    const summary = await expireStartedMatches({ pool })
    console.log(`[expire] ${summary.closed} 场已开赛 → 停售`)
  }

  if (command === 'history' || command === 'all') {
    const results = await crawlHistory({
      pool,
      config,
      backfill,
      maxPages: pagesArg,
    })
    for (const item of results) {
      if (item.error) {
        console.log(`[history:${item.game}] 失败：${item.error}`)
      } else {
        console.log(
          `[history:${item.game}] 写入 ${item.saved} 期` +
            (backfill ? ` · 翻了 ${item.pages} 页` : '') +
            (item.skipped > 0 ? ` · 跳过 ${item.skipped}` : ''),
        )
      }
    }
  }

  console.log(`[done] 本轮耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
}

const pool = createPool(config.database)

function shutdown(signal) {
  if (stopping) {
    return
  }
  stopping = true
  console.log(`\n[crawler] 收到 ${signal}，当前批次结束后退出`)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

try {
  if (everySeconds > 0) {
    console.log(`[crawler] 循环模式，间隔 ${everySeconds}s，命令 ${command}`)
    while (!stopping) {
      try {
        await runOnce()
      } catch (error) {
        // 单轮失败不应该让循环退出，网络抖动是常态
        console.error(`[crawler] 本轮失败：${error instanceof Error ? error.message : String(error)}`)
      }
      if (stopping) {
        break
      }
      await sleep(everySeconds * 1000)
    }
  } else {
    await runOnce()
  }
} catch (error) {
  console.error(`[crawler] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await pool.end().catch(() => {})
}
