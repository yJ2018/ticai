import { KINDS, defaultKindForGame, predictionConfigKey } from '../analysis/configs.mjs'
import {
  ANALYSIS_ENGINE,
  defaultConfigKey,
  ensureSnapshot,
  listLatestVersions,
  loadGameRow,
  readLatestSnapshot,
} from '../analysis/compute.mjs'
import { query } from '../db.mjs'
import { HttpError, intParam, sendData, textParam } from '../lib.mjs'

/**
 * 开奖分析快照的只读接口。
 *
 * 前端不再「下载全量开奖 → Worker 里算 1.5s」，而是直接取已经算好的结果：
 *   analysis  与前端 analyze* 返回值同构，可直接渲染；
 *   sample    溯源：基于哪一期末号、哪一天、多少期样本；
 *   stale     库里最后一期开奖是否已经领先这份快照。
 *
 * 快照缺失时（新库 / 新彩种 / 爬虫没跑）会现算一次并落库，保证接口永远可用；
 * 正常路径是开奖入库时就已算好，这里只命中一行 JSONB。
 */

const GAME_PATTERN = /^[0-9a-z]{2,8}$/i

export function createLotteryAnalysisHandlers(config) {
  const runQuery = (text, params) => query(config, text, params)
  /** 同一组合的并发首次请求只算一次 */
  const inflight = new Map()

  async function resolveGame(gameKey) {
    if (!GAME_PATTERN.test(gameKey)) {
      throw new HttpError(400, 'game 参数不合法（用 pl5 / qxc / dlt 或体彩 gameNo）')
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

  async function latest(ctx) {
    const handlerStartedAt = performance.now()
    const game = await resolveGame(textParam(ctx.url, 'game', 'pl5'))

    const kind = textParam(ctx.url, 'kind', '') || defaultKindForGame(game)
    if (!KINDS.includes(kind)) {
      throw new HttpError(400, `不支持的 kind：${kind}（可用 ${KINDS.join(' / ')}）`)
    }

    // 目前只有马尔可夫阶数开放成参数：1–5 都在开奖时预算好了
    const order = intParam(ctx.url, 'order', 0, { min: 1, max: 5 })
    // 权重滑块：`w=34-20-22-14-10`（五项百分比），只在 prediction 生效；
    // 参数化后 configKey 带上 `;w=...`，按参数各存一条快照。
    const rawWeights = textParam(ctx.url, 'w', '')
    let scoreWeights
    if (kind === 'prediction' && rawWeights) {
      const values = rawWeights.split('-').map(Number)
      if (values.length === 5 && values.every((value) => Number.isFinite(value))) {
        scoreWeights = {
          recent: values[0] / 100,
          long: values[1] / 100,
          omission: values[2] / 100,
          transition: values[3] / 100,
          pairTransition: values[4] / 100,
        }
      }
    }
    const configKey =
      kind === 'prediction'
        ? predictionConfigKey({ markovOrder: order || undefined, scoreWeights })
        : defaultConfigKey(kind)

    // 只读一次库：快照 + 库里最后一期开奖在一条 SQL 里取回（跨境库每次往返 0.5–1.5s）
    const readStartedAt = performance.now()
    let snapshot = await readLatestSnapshot(runQuery, { gameNo: game.game_no, kind, configKey })
    const readMs = performance.now() - readStartedAt
    let triggered = false

    if (!snapshot) {
      triggered = true
      snapshot = await computeOnce(`${game.game_no}|${kind}|${configKey}`, () =>
        ensureSnapshot({
          runQuery,
          game,
          kind,
          configKey,
          source: 'api',
          log: (message) => console.log(message),
        }),
      )
    }

    if (!snapshot) {
      throw new HttpError(
        404,
        `还没有 ${game.name} ${kind} 的分析结果：样本不足或开奖还没抓取。` +
          '可执行 npm run analyze:snapshot 手动生成。',
      )
    }

    const latestDraw = snapshot.latestDraw
    const stale = Boolean(latestDraw && latestDraw.issueSeq > snapshot.sample.throughIssueSeq)

    sendData(
      ctx.res,
      {
        game: {
          gameKey: game.game_key,
          gameNo: game.game_no,
          name: game.name,
          positional: Boolean(game.is_positional),
          mainCount: game.main_count,
        },
        kind,
        configKey,
        sample: snapshot.sample,
        engine: ANALYSIS_ENGINE,
        analysis: snapshot.payload,
        computedAt: snapshot.computedAt,
        source: snapshot.source,
        durationMs: snapshot.durationMs,
        triggered,
        stale,
        latestDraw,
      },
      {
        // 同一期快照是不变的，可以放心让浏览器/CDN 缓存；
        // 落后于最新开奖时缩短到 30s，避免别人看到昨天的分析。
        'cache-control': stale
          ? 'public, max-age=30, s-maxage=60'
          : 'public, max-age=300, s-maxage=900, stale-while-revalidate=120',
        'x-analysis-game': game.game_key,
        'x-analysis-kind': kind,
        'x-analysis-config': configKey,
        'x-analysis-through-issue': snapshot.sample.throughIssue,
        'x-analysis-through-date': snapshot.sample.throughDrawDate,
        'x-analysis-draw-count': String(snapshot.sample.drawCount),
        'x-analysis-computed-at': snapshot.computedAt ?? '',
        'x-analysis-stale': stale ? '1' : '0',
        'x-analysis-source': triggered ? 'computed-on-read' : snapshot.source,
        // 浏览器 Network → Timing 里能直接看出慢在库还是慢在计算
        'server-timing': `snapshot;dur=${readMs.toFixed(1)},app;dur=${(performance.now() - handlerStartedAt).toFixed(1)}`,
      },
    )
  }

  /** 巡检用：每个彩种每种分析的最新快照，以及是否落后于最后一期开奖 */
  async function snapshots(ctx) {
    const rawGame = textParam(ctx.url, 'game', '')
    const game = rawGame ? await resolveGame(rawGame) : null
    const versions = await listLatestVersions(runQuery, { gameNo: game?.game_no ?? null })

    const byGame = new Map()
    for (const item of versions) {
      const current = byGame.get(item.gameNo)
      if (current) {
        current.items.push(item)
      } else {
        byGame.set(item.gameNo, {
          gameNo: item.gameNo,
          gameKey: item.gameKey,
          gameName: item.gameName,
          latestIssue: item.latestIssue,
          latestDrawDate: item.latestDrawDate,
          items: [item],
        })
      }
    }

    sendData(ctx.res, {
      games: [...byGame.values()],
    })
  }

  return { latest, snapshots }
}
