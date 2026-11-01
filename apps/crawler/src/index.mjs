import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createConfig, loadEnv } from './config.mjs'
import { createPool } from './db.mjs'
import { sleep } from './http.mjs'
import { crawlDetails } from './tasks/details.mjs'
import { expireStartedMatches } from './tasks/expire.mjs'
import { crawlHistory } from './tasks/history.mjs'
import { importLineups } from './tasks/lineups.mjs'
import { crawlLineupsEspn } from './tasks/lineups-espn.mjs'
import { crawlMatches } from './tasks/matches.mjs'
import { crawlOfficialData, describeOfficialResult } from './tasks/official.mjs'
import { crawlMatchResults } from './tasks/results.mjs'

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
  node src/index.mjs results [--days=3] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
  node src/index.mjs history [--backfill] [--pages=N] [--game=pl5,qxc] [--delay=3000] [--every=600]
  node src/index.mjs details [--injury-only] [--limit=10] [--match=2042155] [--every=600]
  node src/index.mjs lineups --file=lineups.json [--dry]
  node src/index.mjs lineups-espn [--window=6] [--limit=20] [--dry]
  node src/index.mjs expire
  node src/index.mjs official
  node src/index.mjs all [--every=60]

命令：
  matches   在售赛程 + 赔率，按内容 hash 去重写入快照
  results   赛果开奖：一次拿一批比赛的比分与各玩法结果
  history   四个彩种开奖；--backfill 逐页回灌
  details   对战数据：默认伤停 + 积分/交锋/近况/射手，--injury-only 只抓伤停
  lineups   导入阵容（JSON），--dry 只预演不落库
  lineups-espn  从 ESPN 抓赛前首发（纯 HTTP，不用浏览器）
  expire    本地状态收敛：已开赛的比赛标为停售（不发请求）
  official  只刷体彩官网数据：赛程赔率 + 开奖 + 伤停赛果（不含阵容）
  all       两者都跑（不含 details，它太贵）

说明：
  每轮之间至少间隔 CRAWL_DELAY_MS，别把体彩当自家接口打。
  抓取结果写入 crawl_run，/api/health 靠它判断数据新鲜度。
`.trim()

if (hasFlag('help') || command === 'help') {
  console.log(USAGE)
  process.exit(0)
}

if (!['matches', 'results', 'history', 'details', 'lineups', 'lineups-espn', 'expire', 'official', 'all'].includes(command)) {
  console.error(`未知命令：${command}\n\n${USAGE}`)
  process.exit(1)
}

if (!config.database.url) {
  console.error('缺少 DATABASE_URL，请在仓库根 .env 或 apps/crawler/.env 里配置')
  process.exit(1)
}

const everySeconds = Number(flagValue('every', '0')) || 0
const backfill = hasFlag('backfill')
const pagesArg = Number(flagValue('pages', '0')) || undefined
const delayArg = Number(flagValue('delay', '0')) || undefined
const gameKeys = (flagValue('game', '') || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

let stopping = false

async function runOnce() {
  const startedAt = Date.now()

  if (command === 'matches' || command === 'all') {
    const summary = await crawlMatches({ pool, config })
    console.log(
      `[matches] ${summary.matches} 场 · 赔率变更 ${summary.changed} · 新下架 ${summary.closed} · 跳过 ${summary.skipped}`,
    )
  }

  if (command === 'results' || command === 'all') {
    const summary = await crawlMatchResults({
      pool,
      config,
      days: Number(flagValue('days', '3')) || 3,
      begin: flagValue('from', ''),
      end: flagValue('to', ''),
    })
    console.log(
      `[results] ${summary.from}~${summary.to} · ${summary.requests} 次请求 · ${summary.matches} 场 · 变更 ${summary.changed}` +
        ` · 有比分 ${summary.settled} · 新关联 ${summary.linked} · 回写比赛 ${summary.matchesSynced} · 失败 ${summary.failed}`,
    )
  }

  if (command === 'details') {
    const summary = await crawlDetails({
      pool,
      config,
      limit: Number(flagValue('limit', '10')) || 10,
      // 与 daemon 保持一致：默认抓满 7 个源，只抓伤停用 --injury-only
      full: !hasFlag('injury-only'),
      matchIds: (flagValue('match', '') || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    })
    console.log(
      `[details] ${summary.matches} 场 · ${summary.requests} 次请求 · 比分更新 ${summary.results} · 伤停 ${summary.injuries} · 失败 ${summary.failed}`,
    )
  }

  if (command === 'lineups-espn') {
    const summary = await crawlLineupsEspn({
      pool,
      windowHours: Number(flagValue('window', '6')) || 6,
      limit: Number(flagValue('limit', '20')) || 20,
      dryRun: hasFlag('dry'),
    })
    console.log(
      `[lineups-espn] ${summary.matched} 场候选 · 入库 ${summary.found} · 跳过 ${summary.skipped} · 球员 ${summary.players}` +
        (summary.dryRun ? '（预演未落库）' : ''),
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

  if (command === 'official') {
    const result = await crawlOfficialData({ pool, config })
    console.log(`[official] ${describeOfficialResult(result)}`)
  }

  if (command === 'history' || command === 'all') {
    const results = await crawlHistory({
      pool,
      config,
      backfill,
      maxPages: pagesArg,
      delayMs: delayArg,
      gameKeys,
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
