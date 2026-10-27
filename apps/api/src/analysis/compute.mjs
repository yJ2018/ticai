import { analyzeDltRecommendation } from './dlt-recommendation.mjs'
import { analyzeHistoryPrediction, analyzeMathTrendPrediction } from './history-prediction.mjs'
import {
  DLT_WINDOW,
  ENGINE_VERSION,
  analysisOptions,
  dltConfigKey,
  mathTrendConfigKey,
  predictionConfigKey,
  presetsForGame,
} from './configs.mjs'
import { ENGINE_DIGEST } from './generated.mjs'

/**
 * 开奖分析快照：算一次 → 存库 → 接口直读。
 *
 * 数据流：
 *   lottery_draw（全量历史） → analyze*(全量样本) → lottery_analysis_snapshot（含溯源）
 *
 * 为什么不是「请求时现算」：
 *   排列五 7760 期一次全量回测约 1.5s，Vercel 冷启动 + 远端库往返叠上去就是 3–6s，
 *   而结果只在多了一期开奖时才变。开奖后算一次、同一期反复读，才是这套算法的正确用法。
 *
 * 调用方：
 *   - 爬虫 crawl:history 写入新开奖后（事件触发，见 tasks/history.mjs）
 *   - scripts/analyze-snapshot.mjs（手动/回填）
 *   - API 首次请求时快照缺失的兜底（只算被请求的那一个组合）
 *
 * 所有函数只依赖一个 `runQuery(text, params)`：
 *   爬虫传 pool.query，API 传 (text, params) => query(config, text, params)。
 */

const GAME_SQL = `
  select game_no, game_key, name, is_positional, digit_count, main_count, extra_count
  from lottery_game
  where game_no = $1 or game_key = $1
  limit 1
`

const DRAWS_SQL = `
  select
    issue,
    issue_seq,
    to_char(draw_date, 'YYYY-MM-DD') as draw_date,
    main_numbers,
    extra_numbers
  from lottery_draw
  where game_no = $1
  order by issue_seq desc
`

const UPSERT_SQL = `
  insert into lottery_analysis_snapshot (
    game_no, kind, config_key,
    through_issue, through_issue_seq, through_draw_date,
    from_issue, from_issue_seq, from_draw_date,
    draw_count, payload, meta, source, crawl_run_id, duration_ms
  ) values (
    $1, $2, $3,
    $4, $5, $6,
    $7, $8, $9,
    $10, $11::jsonb, $12::jsonb, $13, $14, $15
  )
  on conflict (game_no, kind, config_key, through_issue) do update set
    through_issue_seq = excluded.through_issue_seq,
    through_draw_date  = excluded.through_draw_date,
    from_issue         = excluded.from_issue,
    from_issue_seq     = excluded.from_issue_seq,
    from_draw_date     = excluded.from_draw_date,
    draw_count         = excluded.draw_count,
    payload            = excluded.payload,
    meta               = excluded.meta,
    source             = excluded.source,
    crawl_run_id       = coalesce(excluded.crawl_run_id, lottery_analysis_snapshot.crawl_run_id),
    duration_ms        = excluded.duration_ms,
    computed_at        = now()
  returning id, computed_at
`

// 一次查询同时拿到快照和「库里最后一期开奖」：跨境库每次往返 0.5–1.5s，
// 读接口多一次往返就是多 1s+，能合并就合并。
const LATEST_SNAPSHOT_SQL = `
  select
    s.id,
    s.game_no,
    s.kind,
    s.config_key,
    s.through_issue,
    s.through_issue_seq,
    to_char(s.through_draw_date, 'YYYY-MM-DD') as through_draw_date,
    s.from_issue,
    s.from_issue_seq,
    to_char(s.from_draw_date, 'YYYY-MM-DD') as from_draw_date,
    s.draw_count,
    s.payload,
    s.meta,
    s.source,
    s.duration_ms,
    s.computed_at,
    d.issue      as latest_issue,
    d.issue_seq  as latest_issue_seq,
    to_char(d.draw_date, 'YYYY-MM-DD') as latest_draw_date
  from lottery_analysis_snapshot s
  left join lateral (
    select dd.issue, dd.issue_seq, dd.draw_date
    from lottery_draw dd
    where dd.game_no = s.game_no
    order by dd.issue_seq desc
    limit 1
  ) d on true
  where s.game_no = $1 and s.kind = $2 and s.config_key = $3
  order by s.through_issue_seq desc
  limit 1
`

const STORED_VERSIONS_SQL = `
  select kind, config_key, through_issue_seq
  from lottery_analysis_latest
  where game_no = $1
`

const LATEST_VERSIONS_SQL = `
  select v.game_no, v.game_key, v.game_name, v.kind, v.config_key, v.through_issue, v.through_issue_seq,
         to_char(v.through_draw_date, 'YYYY-MM-DD') as through_draw_date,
         v.draw_count, v.source, v.duration_ms, v.computed_at,
         v.latest_issue, v.latest_issue_seq, to_char(v.latest_draw_date, 'YYYY-MM-DD') as latest_draw_date
  from lottery_analysis_latest v
  where ($1::text is null or v.game_no = $1 or v.game_key = $1)
  order by v.game_key, v.kind, v.config_key
`

/** 算法版本：写进每条快照的 meta，事后能判断结果是哪一版代码算的 */
export const ANALYSIS_ENGINE = Object.freeze({
  version: ENGINE_VERSION,
  digest: ENGINE_DIGEST,
  runtime: `node ${process.version}`,
})

export async function loadGameRow(runQuery, gameKeyOrNo) {
  const { rows } = await runQuery(GAME_SQL, [String(gameKeyOrNo)])
  return rows[0] ?? null
}

/** 全量开奖（倒序）。分析函数内部会自己排正序，这里保持「最新在前」便于取溯源。 */
export async function loadDraws(runQuery, gameNo) {
  const { rows } = await runQuery(DRAWS_SQL, [gameNo])
  return rows.map((row) => ({
    issue: row.issue,
    issueSeq: Number(row.issue_seq),
    drawDate: row.draw_date,
    // 与前端 split(numbers_text) 等价：位置型是一串个位数，大乐透是 5 个前区 + 2 个后区
    numbers: [...(row.main_numbers ?? []), ...(row.extra_numbers ?? [])].map(String),
  }))
}

export async function readLatestSnapshot(runQuery, { gameNo, kind, configKey }) {
  const { rows } = await runQuery(LATEST_SNAPSHOT_SQL, [gameNo, kind, configKey])
  return rows[0] ? toSnapshot(rows[0]) : null
}

export async function listLatestVersions(runQuery, { gameNo = null } = {}) {
  const { rows } = await runQuery(LATEST_VERSIONS_SQL, [gameNo])
  return rows.map((row) => ({
    gameNo: row.game_no,
    gameKey: row.game_key,
    gameName: row.game_name,
    kind: row.kind,
    configKey: row.config_key,
    throughIssue: row.through_issue,
    throughIssueSeq: Number(row.through_issue_seq),
    throughDrawDate: row.through_draw_date,
    drawCount: row.draw_count,
    source: row.source,
    durationMs: row.duration_ms,
    computedAt: toIso(row.computed_at),
    latestIssue: row.latest_issue,
    latestIssueSeq: row.latest_issue_seq === null ? null : Number(row.latest_issue_seq),
    latestDrawDate: row.latest_draw_date,
    stale: row.latest_issue_seq === null ? false : Number(row.latest_issue_seq) > Number(row.through_issue_seq),
  }))
}

function toSnapshot(row) {
  return {
    id: Number(row.id),
    gameNo: row.game_no,
    kind: row.kind,
    configKey: row.config_key,
    sample: {
      throughIssue: row.through_issue,
      throughIssueSeq: Number(row.through_issue_seq),
      throughDrawDate: row.through_draw_date,
      fromIssue: row.from_issue,
      fromIssueSeq: row.from_issue_seq === null ? null : Number(row.from_issue_seq),
      fromDrawDate: row.from_draw_date,
      drawCount: row.draw_count,
    },
    latestDraw:
      row.latest_issue === null
        ? null
        : {
            issue: row.latest_issue,
            issueSeq: Number(row.latest_issue_seq),
            drawDate: row.latest_draw_date,
          },
    payload: row.payload,
    meta: row.meta ?? {},
    source: row.source,
    durationMs: row.duration_ms,
    computedAt: toIso(row.computed_at),
  }
}

function toIso(value) {
  if (!value) {
    return null
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** 每种分析实际吃进去了多少期：预测用全量，另两个有固定窗口 */
function usedDrawCount(kind, draws, options) {
  if (kind === 'math_trend') {
    return Math.min(options.sampleWindow, draws.length)
  }
  if (kind === 'dlt') {
    return Math.min(DLT_WINDOW, draws.length)
  }
  return draws.length
}

/**
 * 纯计算：给定开奖序列（倒序）和参数，返回分析结果 + 溯源需要的期号范围。
 * 单独抽出来是为了让测试不必碰数据库。
 */
export function computeAnalysis(kind, game, draws, configKey) {
  if (draws.length === 0) {
    return { payload: null, sample: null }
  }

  const options = analysisOptions(kind, game, configKey)
  let payload

  if (kind === 'prediction') {
    payload = analyzeHistoryPrediction(
      draws.map((draw) => ({ issue: draw.issue, numbers: draw.numbers })),
      options,
    )
  } else if (kind === 'math_trend') {
    payload = analyzeMathTrendPrediction(
      draws.map((draw) => ({ issue: draw.issue, numbers: draw.numbers })),
      options,
    )
  } else if (kind === 'dlt') {
    // 大乐透推演只认「最近 300 期、最新在前」，函数内部按窗口截断
    payload = analyzeDltRecommendation(draws.map((draw) => ({ numbers: draw.numbers })))
  } else {
    throw new Error(`未知分析种类：${kind}`)
  }

  if (!payload) {
    return { payload: null, sample: null }
  }

  const used = Math.max(1, usedDrawCount(kind, draws, options))
  const latest = draws[0]
  const oldest = draws[Math.min(used, draws.length) - 1]

  return {
    payload,
    sample: {
      throughIssue: latest.issue,
      throughIssueSeq: latest.issueSeq,
      throughDrawDate: latest.drawDate,
      fromIssue: oldest.issue,
      fromIssueSeq: oldest.issueSeq,
      fromDrawDate: oldest.drawDate,
      drawCount: Math.min(used, draws.length),
    },
  }
}

export async function saveSnapshot(runQuery, snapshot) {
  const row = toRow(snapshot)
  const { rows } = await runQuery(UPSERT_SQL, row)
  return rows[0]
}

const UPSERT_COLUMNS = [
  'game_no',
  'kind',
  'config_key',
  'through_issue',
  'through_issue_seq',
  'through_draw_date',
  'from_issue',
  'from_issue_seq',
  'from_draw_date',
  'draw_count',
  'payload',
  'meta',
  'source',
  'crawl_run_id',
  'duration_ms',
]

const UPSERT_TYPES = [
  'text[]',
  'text[]',
  'text[]',
  'text[]',
  'bigint[]',
  'date[]',
  'text[]',
  'bigint[]',
  'date[]',
  'int[]',
  'jsonb[]',
  'jsonb[]',
  'text[]',
  'bigint[]',
  'int[]',
]

// 一轮开奖要写 6 条（5 个阶数 + 数学走势）。跨境库每次往返 1–3s，
// 逐条 upsert 会让「算 8s、写 30s」变成常态，所以合并成一条 unnest 多行写。
const UPSERT_BATCH_SQL = `
  insert into lottery_analysis_snapshot (${UPSERT_COLUMNS.join(', ')})
  select * from unnest(
    ${UPSERT_TYPES.map((type, index) => `$${index + 1}::${type}`).join(', ')}
  )
  on conflict (game_no, kind, config_key, through_issue) do update set
    through_issue_seq = excluded.through_issue_seq,
    through_draw_date  = excluded.through_draw_date,
    from_issue         = excluded.from_issue,
    from_issue_seq     = excluded.from_issue_seq,
    from_draw_date     = excluded.from_draw_date,
    draw_count         = excluded.draw_count,
    payload            = excluded.payload,
    meta               = excluded.meta,
    source             = excluded.source,
    crawl_run_id       = coalesce(excluded.crawl_run_id, lottery_analysis_snapshot.crawl_run_id),
    duration_ms        = excluded.duration_ms,
    computed_at        = now()
`

/** 快照对象 → 15 个字段的一行（顺序与 UPSERT_COLUMNS 一致） */
function toRow(snapshot) {
  return [
    snapshot.gameNo,
    snapshot.kind,
    snapshot.configKey,
    snapshot.sample.throughIssue,
    snapshot.sample.throughIssueSeq,
    snapshot.sample.throughDrawDate,
    snapshot.sample.fromIssue,
    snapshot.sample.fromIssueSeq,
    snapshot.sample.fromDrawDate,
    snapshot.sample.drawCount,
    JSON.stringify(snapshot.payload),
    JSON.stringify(snapshot.meta ?? {}),
    snapshot.source,
    snapshot.crawlRunId ?? null,
    snapshot.durationMs ?? null,
  ]
}

export async function saveSnapshots(runQuery, snapshots) {
  if (snapshots.length === 0) {
    return 0
  }
  const rows = snapshots.map(toRow)
  // 按列转置：pg 会把数组按列传进去，由 unnest 展开成多行
  const params = UPSERT_COLUMNS.map((_, column) => rows.map((row) => row[column]))
  await runQuery(UPSERT_BATCH_SQL, params)
  return snapshots.length
}

function buildMeta({ kind, game, configKey, options, drawCount }) {
  return {
    engine: 'node',
    engineVersion: ENGINE_VERSION,
    engineDigest: ENGINE_DIGEST,
    kind,
    gameKey: game.game_key,
    configKey,
    options,
    loadedDrawCount: drawCount,
  }
}

/**
 * 重算某个彩种的全部预设。
 *
 * - 默认跳过「库里的快照已经覆盖到最新一期」的组合：爬虫每 30 分钟抓一次，
 *   没有新开奖时不该重复烧 CPU；
 * - 一期有新开奖时，只重算这一期（结果按 through_issue 幂等 upsert）。
 */
export async function refreshSnapshots({
  runQuery,
  gameKey,
  source = 'cli',
  crawlRunId = null,
  force = false,
  presets,
  log = null,
}) {
  const game = await loadGameRow(runQuery, gameKey)
  if (!game) {
    throw new Error(`未知彩种：${gameKey}（可能还没执行 npm run db:seed）`)
  }

  const plan = Array.isArray(presets) && presets.length > 0 ? presets : presetsForGame(game)
  if (plan.length === 0) {
    return { game, latest: null, results: [] }
  }

  const draws = await loadDraws(runQuery, game.game_no)
  if (draws.length === 0) {
    return { game, latest: null, results: [] }
  }

  const latestSeq = draws[0].issueSeq
  const stored = new Map()
  if (!force) {
    const { rows } = await runQuery(STORED_VERSIONS_SQL, [game.game_no])
    for (const row of rows) {
      stored.set(`${row.kind}|${row.config_key}`, Number(row.through_issue_seq))
    }
  }

  const results = []
  const pending = []

  for (const preset of plan) {
    const key = `${preset.kind}|${preset.configKey}`
    const storedSeq = stored.get(key)

    if (!force && storedSeq !== undefined && storedSeq >= latestSeq) {
      results.push({ ...preset, status: 'skipped', throughIssue: draws[0].issue })
      continue
    }

    const startedAt = performance.now()
    const { payload, sample } = computeAnalysis(preset.kind, game, draws, preset.configKey)
    const durationMs = Math.round(performance.now() - startedAt)

    if (!payload || !sample) {
      results.push({ ...preset, status: 'empty', durationMs })
      log?.(`  · ${game.game_key} ${preset.kind}/${preset.configKey} 样本不足，跳过`)
      continue
    }

    const meta = {
      ...buildMeta({
        kind: preset.kind,
        game,
        configKey: preset.configKey,
        options: analysisOptions(preset.kind, game, preset.configKey),
        drawCount: draws.length,
      }),
      ...(preset.meta ?? {}),
    }

    pending.push({
      gameNo: game.game_no,
      kind: preset.kind,
      configKey: preset.configKey,
      sample,
      payload,
      meta,
      source,
      crawlRunId,
      durationMs,
    })

    results.push({
      ...preset,
      status: 'computed',
      throughIssue: sample.throughIssue,
      throughDrawDate: sample.throughDrawDate,
      drawCount: sample.drawCount,
      durationMs,
    })
  }

  // 一次写完，跨境库只花一次往返
  const written = await saveSnapshots(runQuery, pending)
  if (written > 0) {
    for (const result of results) {
      if (result.status !== 'computed') {
        continue
      }
      log?.(
        `  · ${game.game_key} ${result.kind}/${result.configKey} → ` +
          `${result.throughIssue}（${result.throughDrawDate}）· ${result.drawCount} 期 · ${result.durationMs}ms`,
      )
    }
  }

  return { game, latest: draws[0], results }
}

/** 快照缺失时的兜底：只算被请求的那一个组合（不铺全部预设） */
export async function ensureSnapshot({ runQuery, game, kind, configKey, source = 'api', log = null }) {
  const draws = await loadDraws(runQuery, game.game_no)
  if (draws.length === 0) {
    return null
  }

  const startedAt = performance.now()
  const { payload, sample } = computeAnalysis(kind, game, draws, configKey)
  const durationMs = Math.round(performance.now() - startedAt)
  if (!payload || !sample) {
    return null
  }

  await saveSnapshot(runQuery, {
    gameNo: game.game_no,
    kind,
    configKey,
    sample,
    payload,
    meta: buildMeta({ kind, game, configKey, options: analysisOptions(kind, game, configKey), drawCount: draws.length }),
    source,
    durationMs,
  })

  log?.(`[analysis] ${game.game_key} ${kind}/${configKey} 快照缺失，已现算并落库（${durationMs}ms）`)

  return readLatestSnapshot(runQuery, { gameNo: game.game_no, kind, configKey })
}

/** 供 API 做「参数 → configKey」的默认值解析 */
export function defaultConfigKey(kind) {
  if (kind === 'prediction') {
    return predictionConfigKey()
  }
  if (kind === 'math_trend') {
    return mathTrendConfigKey()
  }
  return dltConfigKey()
}
