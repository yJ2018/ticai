import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultConfigKey, loadGameRow } from '../apps/api/src/analysis/compute.mjs'
import { recommendationKindForGame } from '../apps/api/src/analysis/recommendation-track.mjs'
import { createConfig, loadEnv } from '../apps/api/src/config.mjs'
import { closePool, query } from '../apps/api/src/db.mjs'
import {
  ensureRecommendationTrack,
  readRecommendationTrackStat,
} from '../apps/api/src/repos/recommendation-track.mjs'

/**
 * 号码池型推荐命中归档的手动入口（首次回填 / 换算法后重建 / 巡检）。
 *
 *   node scripts/backfill-recommendation-track.mjs                  # 缺什么补什么（最近 300 期）
 *   node scripts/backfill-recommendation-track.mjs --force          # 全部重算
 *   node scripts/backfill-recommendation-track.mjs --game=ssq,kl8   # 只跑指定彩种
 *   node scripts/backfill-recommendation-track.mjs --status         # 只读巡检
 *
 * 正常情况下不用跑：crawl:history 抓到新开奖后会增量补一期。
 * 首次上线或刚回填完历史开奖时跑一次，避免前端第一次打开时由 API 兜底现算。
 */

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

async function listPoolGames(gameKeys) {
  const { rows } = await runQuery(
    'select game_no, game_key, name from lottery_game where not is_positional order by game_key',
  )
  return rows.filter(
    (row) =>
      ['dlt', 'ssq', 'kl8'].includes(row.game_key) &&
      (gameKeys.length === 0 || gameKeys.includes(row.game_key)),
  )
}

async function status() {
  const { rows } = await runQuery(
    `select game_key, game_name, kind, config_key, through_issue, samples, payload,
            latest_issue, computed_at
     from lottery_recommendation_track_latest
     order by game_key`,
  )
  if (rows.length === 0) {
    console.log('[hits] 还没有任何推荐命中归档，先跑一次 npm run track:hits')
    return
  }

  console.log('\n[hits] 推荐命中归档')
  for (const row of rows) {
    const overall = row.payload?.overall ?? {}
    console.log(
      `  ${row.game_key.padEnd(4)} ${String(row.config_key).padEnd(11)} ` +
        `归档 ${String(row.samples).padStart(5)} 期 · 基准 ${row.through_issue} · ` +
        `最新 ${row.latest_issue ?? '-'} · 平均命中 ${Number(overall.avgMainHits ?? 0).toFixed(2)} · ` +
        `覆盖率 ${formatRate(overall.captureRate)} · 算于 ${formatTime(row.computed_at)}`,
    )
  }
  console.log('')
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[hits] 缺少 DATABASE_URL，请在仓库根 .env 里配置')
    process.exitCode = 1
    return
  }

  if (hasFlag('status')) {
    await status()
    return
  }

  const games = await listPoolGames(
    flagValue('game', '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
  if (games.length === 0) {
    console.error('[hits] 没有可归档的号码池彩种（先执行 npm run db:migrate）')
    process.exitCode = 1
    return
  }

  const force = hasFlag('force')
  let failed = 0

  for (const game of games) {
    const startedAt = Date.now()
    try {
      const gameRow = await loadGameRow(runQuery, game.game_no)
      const kind = recommendationKindForGame(gameRow)
      if (!kind) {
        throw new Error(`未知推演类型：${game.game_key}`)
      }
      const configKey = defaultConfigKey(kind)
      const before = await readRecommendationTrackStat(runQuery, {
        gameNo: game.game_no,
        configKey,
      })
      const result = await ensureRecommendationTrack({
        runQuery,
        game: gameRow,
        configKey,
        full: force || !before,
        source: 'cli',
        log: (message) => console.log(message),
      })
      const overall = result.stat?.payload?.overall
      console.log(
        `[hits] ${game.game_key}: ${result.status === 'skipped' ? '已最新' : '已归档'} · ` +
          `写入 ${result.written} 期 · ` +
          (overall
            ? `平均命中 ${Number(overall.avgMainHits ?? 0).toFixed(2)} · 覆盖率 ${formatRate(overall.captureRate)} · `
            : '') +
          `${((Date.now() - startedAt) / 1000).toFixed(1)}s` +
          (result.stat?.throughIssue ? ` · 基准 ${result.stat.throughIssue}` : ''),
      )
    } catch (error) {
      failed += 1
      console.error(
        `[hits] ${game.game_key} 失败：${error instanceof Error ? error.message : String(error)}`,
      )
      process.exitCode = 1
    }
  }

  await status()
  if (failed > 0) {
    console.error(`[hits] ${failed} 个彩种失败`)
  }
}

try {
  await main()
} finally {
  await closePool()
}
