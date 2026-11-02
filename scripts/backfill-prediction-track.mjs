import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { predictionConfigKey } from '../apps/api/src/analysis/configs.mjs'
import { loadGameRow } from '../apps/api/src/analysis/compute.mjs'
import { createConfig, loadEnv } from '../apps/api/src/config.mjs'
import { closePool, query } from '../apps/api/src/db.mjs'
import { ensurePredictionTrack, readTrackStat } from '../apps/api/src/repos/prediction-track.mjs'

/**
 * 逐期参考归档的手动入口（首次回填 / 换算法后重建 / 巡检）。
 *
 *   node scripts/backfill-prediction-track.mjs             # 缺什么补什么
 *   node scripts/backfill-prediction-track.mjs --force     # 全部重算（换算法指纹后）
 *   node scripts/backfill-prediction-track.mjs --game=pl5  # 只跑一个彩种
 *   node scripts/backfill-prediction-track.mjs --status    # 只读巡检
 *
 * 正常情况下不用跑：crawl:history 抓到新开奖后会增量补一期。
 * 首次上线需要跑一次，否则前端第一次打开会由 API 兜底现算（约 0.5s/彩种，可接受但不优雅）。
 */

const MARKOV_ORDER = 2

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
const configKey = predictionConfigKey({ markovOrder: MARKOV_ORDER })

function formatRate(value) {
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`
}

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

async function listPositionalGames(gameKeys) {
  const { rows } = await runQuery(
    'select game_no, game_key, name, is_positional, main_count from lottery_game order by game_key',
  )
  return rows.filter(
    (row) =>
      row.is_positional && (gameKeys.length === 0 || gameKeys.includes(row.game_key)),
  )
}

async function status() {
  const { rows } = await runQuery(
    `select game_key, game_name, config_key, through_issue, samples, payload,
            latest_issue, computed_at
     from lottery_prediction_track_latest
     order by game_key`,
  )
  if (rows.length === 0) {
    console.log('[track] 还没有任何逐期归档，先跑一次 npm run track:backfill')
    return
  }

  console.log('\n[track] 逐期参考归档')
  for (const row of rows) {
    const overall = row.payload?.overall ?? {}
    console.log(
      `  ${row.game_key.padEnd(4)} ${String(row.config_key).padEnd(9)} ` +
        `归档 ${String(row.samples).padStart(5)} 期 · 基准 ${row.through_issue} · ` +
        `最新 ${row.latest_issue ?? '-'} · Top1 ${formatRate(overall.top1Rate)} · ` +
        `Top3 ${formatRate(overall.top3Rate)} · 算于 ${formatTime(row.computed_at)}`,
    )
  }
  console.log('')
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[track] 缺少 DATABASE_URL，请在仓库根 .env 里配置')
    process.exitCode = 1
    return
  }

  if (hasFlag('status')) {
    await status()
    return
  }

  const games = await listPositionalGames(
    flagValue('game', '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
  if (games.length === 0) {
    console.error('[track] 没有可归档的位次彩种（先执行 npm run db:migrate）')
    process.exitCode = 1
    return
  }

  const force = hasFlag('force')
  let failed = 0

  for (const game of games) {
    const startedAt = Date.now()
    try {
      const gameRow = await loadGameRow(runQuery, game.game_no)
      const before = await readTrackStat(runQuery, {
        gameNo: game.game_no,
        configKey,
      })
      const result = await ensurePredictionTrack({
        runQuery,
        game: gameRow,
        configKey,
        full: force || !before,
        source: 'cli',
        log: (message) => console.log(message),
      })
      const overall = result.stat?.payload?.overall
      console.log(
        `[track] ${game.game_key}: ${result.status === 'skipped' ? '已最新' : '已归档'} · ` +
          `写入 ${result.written} 期 · ` +
          (overall
            ? `Top1 ${formatRate(overall.top1Rate)} · Top3 ${formatRate(overall.top3Rate)} · `
            : '') +
          `${((Date.now() - startedAt) / 1000).toFixed(1)}s` +
          (result.stat?.throughIssue ? ` · 基准 ${result.stat.throughIssue}` : ''),
      )
    } catch (error) {
      failed += 1
      console.error(
        `[track] ${game.game_key} 失败：${error instanceof Error ? error.message : String(error)}`,
      )
      process.exitCode = 1
    }
  }

  await status()
  if (failed > 0) {
    console.error(`[track] ${failed} 个彩种失败`)
  }
}

try {
  await main()
} finally {
  await closePool()
}
