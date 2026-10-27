import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { listLatestVersions, refreshSnapshots } from '../apps/api/src/analysis/compute.mjs'
import { createConfig, loadEnv } from '../apps/api/src/config.mjs'
import { closePool, query } from '../apps/api/src/db.mjs'

/**
 * 分析快照的手动入口（回填 / 补算 / 巡检）。
 *
 * 正常路径不用它：crawl:history 抓到新开奖后会自动重算。
 * 这里用于三种情况：
 *   - 新库 / 第一次上线，把历史全量算一遍；
 *   - 算法或参数变了（改完 TS 跑 npm run analysis:sync 后强制重算）；
 *   - 只看状态：--status 打印每个彩种每种分析的最新快照与是否落后开奖。
 *
 *   node scripts/analyze-snapshot.mjs                    # 缺什么补什么
 *   node scripts/analyze-snapshot.mjs --force            # 全部重算
 *   node scripts/analyze-snapshot.mjs --game=pl5,qxc     # 指定彩种
 *   node scripts/analyze-snapshot.mjs --status           # 只读巡检
 */

const DEFAULT_GAMES = ['pl5', 'qxc', 'dlt']

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
loadEnv(root)

const args = process.argv.slice(2)
const hasFlag = (name) => args.includes(`--${name}`)
const flagValue = (name, fallback = '') => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const config = createConfig()
const runQuery = (text, params) => query(config, text, params)

function formatTime(value) {
  if (!value) {
    return '-'
  }
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value))
}

async function status() {
  const gameNo = flagValue('game', '')
  const versions = await listLatestVersions(runQuery, { gameNo: gameNo || null })

  if (versions.length === 0) {
    console.log('[analysis] 还没有任何快照，先跑一次 node scripts/analyze-snapshot.mjs')
    return
  }

  let currentGame = ''
  for (const item of versions) {
    if (item.gameKey !== currentGame) {
      currentGame = item.gameKey
      console.log(`\n[analysis] ${item.gameName}（${item.gameKey}）· 最新开奖 ${item.latestIssue ?? '-'}`)
    }
    console.log(
      `  ${item.stale ? '⚠ 落后' : '✓ 最新'} ${item.kind.padEnd(12)} ${item.configKey.padEnd(44)} ` +
        `基准 ${item.throughIssue}（${item.throughDrawDate}）· ${String(item.drawCount).padStart(5)} 期 · ` +
        `${String(item.durationMs ?? '-').padStart(5)}ms · 算于 ${formatTime(item.computedAt)}`,
    )
  }
  console.log('')
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[analysis] 缺少 DATABASE_URL，请在仓库根 .env 里配置')
    process.exitCode = 1
    return
  }

  if (hasFlag('status')) {
    await status()
    return
  }

  const games = (flagValue('game', '') || DEFAULT_GAMES.join(','))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const force = hasFlag('force')

  let totalComputed = 0
  let totalSkipped = 0

  for (const gameKey of games) {
    const startedAt = Date.now()
    try {
      const result = await refreshSnapshots({
        runQuery,
        gameKey,
        source: 'cli',
        force,
        log: (message) => console.log(`[analysis]${message}`),
      })
      const computed = result.results.filter((item) => item.status === 'computed').length
      const skipped = result.results.filter((item) => item.status === 'skipped').length
      totalComputed += computed
      totalSkipped += skipped
      console.log(
        `[analysis] ${gameKey}: 重算 ${computed} 条 · 已最新 ${skipped} 条 · ` +
          `${((Date.now() - startedAt) / 1000).toFixed(1)}s` +
          (result.latest ? ` · 基准 ${result.latest.issue}（${result.latest.drawDate}）` : ' · 暂无开奖数据'),
      )
    } catch (error) {
      console.error(`[analysis] ${gameKey} 失败：${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  }

  console.log(`\n[analysis] 完成：重算 ${totalComputed} 条 · 已最新 ${totalSkipped} 条`)
  await status()
}

try {
  await main()
} finally {
  await closePool()
}
