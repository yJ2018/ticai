import { ANALYSIS_ENGINE, loadGameRow } from '../analysis/compute.mjs'
import { predictionConfigKey } from '../analysis/configs.mjs'
import { PREDICTION_TRACK_VERSION } from '../analysis/prediction-track.mjs'
import { query } from '../db.mjs'
import { HttpError, intParam, sendData, textParam } from '../lib.mjs'
import {
  ensurePredictionTrack,
  readTrackItems,
  readTrackStat,
} from '../repos/prediction-track.mjs'

/**
 * 逐期参考归档接口。
 *
 *   GET /api/analysis/lottery/track?game=pl5&issues=26291,26290&limit=30
 *
 * 返回：
 *   - items：请求期次的参考号码、逐位命中、组合命中（前端叠加到走势上）；
 *   - summary：全量归档的命中率 / 分位偏差 / 号码偏差 / 滚动曲线（偏差分析面板）；
 *   - sample：归档区间（从哪一期到哪一期、多少期），用于展示「这份统计吃到了哪」。
 *
 * 归档按「开奖前」算：第 N 期的参考只用到第 N-1 期，throughIssue 可以自证没有偷看当期。
 * 正常情况下由爬虫在开奖入库后增量补齐；这里只在缺失/落后时兜底现算一次。
 */

const GAME_PATTERN = /^[0-9a-z]{2,8}$/i
const DEFAULT_MARKOV_ORDER = 2
const MAX_ISSUES = 60
const ISSUE_PATTERN = /^\d{1,10}$/

export function createPredictionTrackHandlers(config) {
  const runQuery = (text, params) => query(config, text, params)
  const inflight = new Map()

  async function resolveGame(gameKey) {
    if (!GAME_PATTERN.test(gameKey)) {
      throw new HttpError(400, 'game 参数不合法（用 pl5 / qxc 或体彩 gameNo）')
    }
    const game = await loadGameRow(runQuery, gameKey)
    if (!game) {
      throw new HttpError(404, `未知彩种：${gameKey}（请先执行 npm run db:seed）`)
    }
    return game
  }

  function computeOnce(key, task) {
    const running = inflight.get(key)
    if (running) {
      return running
    }
    const promise = task().finally(() => inflight.delete(key))
    inflight.set(key, promise)
    return promise
  }

  async function track(ctx) {
    const startedAt = performance.now()
    const game = await resolveGame(textParam(ctx.url, 'game', 'pl5'))
    if (!game.is_positional) {
      throw new HttpError(400, `${game.name} 不是位次彩种，没有逐期参考归档`)
    }

    const configKey = predictionConfigKey({ markovOrder: DEFAULT_MARKOV_ORDER })
    const issues = parseIssues(textParam(ctx.url, 'issues', ''))
    const limit = intParam(ctx.url, 'limit', 30, { min: 1, max: 120 })
    const forceRefresh = textParam(ctx.url, 'refresh', '') === '1'

    let stat = await readTrackStat(runQuery, { gameNo: game.game_no, configKey })
    let triggered = false
    const staleByEngine =
      Boolean(stat) &&
      (stat.engineDigest !== ANALYSIS_ENGINE.digest ||
        stat.payload?.version !== PREDICTION_TRACK_VERSION)
    const behindLatest = Boolean(stat) && (stat.latestIssueSeq ?? 0) > stat.throughIssueSeq

    if (forceRefresh || !stat || staleByEngine || behindLatest) {
      triggered = true
      try {
        const result = await computeOnce(`${game.game_no}|${configKey}`, () =>
          ensurePredictionTrack({
            runQuery,
            game,
            configKey,
            full: forceRefresh || staleByEngine,
            source: 'api',
            log: (message) => console.log(message),
          }),
        )
        stat = result.stat ?? (await readTrackStat(runQuery, { gameNo: game.game_no, configKey }))
      } catch (error) {
        // API 的库账号通常只有 select 权限：归档由爬虫增量补，这里补算失败只降级读旧数据，
        // 不能把「有一条新开奖还没归档」变成整个页面的 500。
        console.warn(
          `[track] ${game.game_key} 补算失败，继续读已存归档：${error?.message ?? error}`,
        )
        stat = await readTrackStat(runQuery, { gameNo: game.game_no, configKey })
      }
    }

    const gameInfo = {
      gameKey: game.game_key,
      gameNo: game.game_no,
      name: game.name,
      positional: Boolean(game.is_positional),
      mainCount: game.main_count ?? 5,
    }

    if (!stat || !stat.payload) {
      sendData(
        ctx.res,
        {
          game: gameInfo,
          configKey,
          ready: false,
          reason: 'not-enough-samples',
          engine: publicEngine(),
          items: [],
          missing: issues ?? [],
          summary: null,
          sample: null,
          stale: false,
          triggered,
        },
        trackHeaders({ triggered, stat: null, startedAt }),
      )
      return
    }

    const items = await readTrackItems(runQuery, {
      gameNo: game.game_no,
      configKey,
      issues,
      limit,
    })
    const returned = new Set(items.map((item) => item.issue))
    const missing = (issues ?? []).filter((issue) => !returned.has(issue))
    const stale = (stat.latestIssueSeq ?? 0) > stat.throughIssueSeq

    sendData(
      ctx.res,
      {
        game: gameInfo,
        configKey,
        ready: true,
        engine: publicEngine(),
        sample: stat.payload.sample,
        summary: stat.payload,
        items,
        missing,
        stale,
        triggered,
        computedAt: stat.computedAt,
      },
      trackHeaders({ triggered, stat, startedAt }),
    )
  }

  return { track }
}

function parseIssues(raw) {
  if (!raw) {
    return null
  }
  const tokens = String(raw)
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
  if (tokens.length === 0) {
    return null
  }
  const invalid = tokens.find((token) => !ISSUE_PATTERN.test(token))
  if (invalid) {
    throw new HttpError(400, `issues 参数不合法：${invalid}`)
  }
  return Array.from(new Set(tokens)).slice(0, MAX_ISSUES)
}

function publicEngine() {
  return {
    version: ANALYSIS_ENGINE.version,
    digest: ANALYSIS_ENGINE.digest,
    runtime: ANALYSIS_ENGINE.runtime,
  }
}

function trackHeaders({ triggered, stat, startedAt }) {
  const stale = Boolean(stat) && (stat.latestIssueSeq ?? 0) > stat.throughIssueSeq
  return {
    'cache-control': triggered
      ? 'private, no-store'
      : stale
        ? 'public, max-age=30, s-maxage=60'
        : 'public, max-age=60, s-maxage=300, stale-while-revalidate=120',
    'x-track-source': triggered ? 'computed-on-read' : 'stored',
    'x-track-stale': stale ? '1' : '0',
    'x-track-through-issue': stat?.throughIssue ?? '',
    'x-track-samples': stat ? String(stat.samples) : '0',
    'server-timing': `track;dur=${(performance.now() - startedAt).toFixed(1)}`,
  }
}
