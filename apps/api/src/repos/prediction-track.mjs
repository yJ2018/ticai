import { ANALYSIS_ENGINE, loadDraws, loadGameRow } from '../analysis/compute.mjs'
import { parsePredictionConfigKey } from '../analysis/configs.mjs'
import {
  PREDICTION_TRACK_VERSION,
  buildPredictionTrack,
  buildTrackStat,
} from '../analysis/prediction-track.mjs'

/**
 * 逐期参考归档的读写层。
 *
 *   lottery_draw（全量） → buildPredictionTrack（walk-forward） →
 *   lottery_prediction_track（每期一行，可回看） + lottery_prediction_track_stat（累计/偏差）
 *
 * 增量策略：
 *   - 已归档到 issue N、库里多了 N+1 → 只对 N+1 做一次排名，累计计数从 stat.state 续算；
 *   - 归档缺失 / 算法指纹变了 / 期号不连续 → 从头重算（full 模式）；
 *   - 写入按 500 行一批 unnest，跨境库不会因为 7700 次往返卡死。
 *
 * 调用方：
 *   - 爬虫开奖入库后（增量）
 *   - scripts/backfill-prediction-track.mjs（首次回填 / 换算法后重建）
 *   - API 首次请求兜底（缺失时现算一次）
 */

const TRACK_COLUMNS = [
  'game_no',
  'config_key',
  'issue',
  'issue_seq',
  'draw_date',
  'through_issue',
  'through_issue_seq',
  'actual',
  'positions',
  'combinations',
  'top1_hits',
  'top3_hits',
  'best_combo_match',
  'engine_version',
  'engine_digest',
]

const TRACK_TYPES = [
  'text[]',
  'text[]',
  'text[]',
  'bigint[]',
  'date[]',
  'text[]',
  'bigint[]',
  'jsonb[]',
  'jsonb[]',
  'jsonb[]',
  'int[]',
  'int[]',
  'int[]',
  'text[]',
  'text[]',
]

const TRACK_UPSERT_SQL = `
  insert into lottery_prediction_track (${TRACK_COLUMNS.join(', ')})
  select * from unnest(
    ${TRACK_TYPES.map((type, index) => `$${index + 1}::${type}`).join(', ')}
  )
  on conflict (game_no, config_key, issue) do update set
    issue_seq        = excluded.issue_seq,
    draw_date        = excluded.draw_date,
    through_issue    = excluded.through_issue,
    through_issue_seq = excluded.through_issue_seq,
    actual           = excluded.actual,
    positions        = excluded.positions,
    combinations     = excluded.combinations,
    top1_hits        = excluded.top1_hits,
    top3_hits        = excluded.top3_hits,
    best_combo_match = excluded.best_combo_match,
    engine_version   = excluded.engine_version,
    engine_digest    = excluded.engine_digest,
    computed_at      = now()
`

const TRACK_STAT_UPSERT_SQL = `
  insert into lottery_prediction_track_stat (
    game_no, config_key, through_issue, through_issue_seq, samples,
    payload, state, engine_version, engine_digest
  ) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
  on conflict (game_no, config_key) do update set
    through_issue     = excluded.through_issue,
    through_issue_seq = excluded.through_issue_seq,
    samples           = excluded.samples,
    payload           = excluded.payload,
    state             = excluded.state,
    engine_version    = excluded.engine_version,
    engine_digest     = excluded.engine_digest,
    computed_at       = now()
`

const TRACK_STAT_SQL = `
  select
    s.game_no,
    s.config_key,
    s.through_issue,
    s.through_issue_seq,
    s.samples,
    s.payload,
    s.state,
    s.engine_version,
    s.engine_digest,
    s.computed_at,
    (select max(issue_seq) from lottery_prediction_track t
      where t.game_no = s.game_no and t.config_key = s.config_key) as track_max_seq,
    (select max(issue_seq) from lottery_draw d where d.game_no = s.game_no) as latest_issue_seq
  from lottery_prediction_track_stat s
  where s.game_no = $1 and s.config_key = $2
`

const TRACK_ITEMS_SQL = `
  select
    issue,
    issue_seq,
    to_char(draw_date, 'YYYY-MM-DD') as draw_date,
    through_issue,
    through_issue_seq,
    actual,
    positions,
    combinations,
    top1_hits,
    top3_hits,
    best_combo_match
  from lottery_prediction_track
  where game_no = $1 and config_key = $2
  order by issue_seq desc
  limit $3
`

const TRACK_ITEMS_BY_ISSUES_SQL = `
  select
    issue,
    issue_seq,
    to_char(draw_date, 'YYYY-MM-DD') as draw_date,
    through_issue,
    through_issue_seq,
    actual,
    positions,
    combinations,
    top1_hits,
    top3_hits,
    best_combo_match
  from lottery_prediction_track
  where game_no = $1 and config_key = $2 and issue = any($3::text[])
  order by issue_seq desc
`

const TRACK_COVERAGE_SQL = `
  select count(*)::int as count, max(issue_seq) as max_seq, min(issue_seq) as min_seq
  from lottery_prediction_track
  where game_no = $1 and config_key = $2
`

const WRITE_CHUNK_SIZE = 500

export async function readTrackStat(runQuery, { gameNo, configKey }) {
  const { rows } = await runQuery(TRACK_STAT_SQL, [gameNo, configKey])
  const row = rows[0]
  if (!row) {
    return null
  }
  return {
    gameNo: row.game_no,
    configKey: row.config_key,
    throughIssue: row.through_issue,
    throughIssueSeq: Number(row.through_issue_seq),
    samples: Number(row.samples),
    payload: row.payload,
    state: row.state,
    engineVersion: row.engine_version,
    engineDigest: row.engine_digest,
    computedAt: toIso(row.computed_at),
    trackMaxSeq: row.track_max_seq === null ? null : Number(row.track_max_seq),
    latestIssueSeq: row.latest_issue_seq === null ? null : Number(row.latest_issue_seq),
  }
}

export async function readTrackItems(runQuery, { gameNo, configKey, issues = null, limit = 40 }) {
  const { rows } = Array.isArray(issues) && issues.length > 0
    ? await runQuery(TRACK_ITEMS_BY_ISSUES_SQL, [gameNo, configKey, issues])
    : await runQuery(TRACK_ITEMS_SQL, [gameNo, configKey, Math.min(Math.max(limit, 1), 200)])

  return rows.map(toTrackItem)
}

export async function readTrackCoverage(runQuery, { gameNo, configKey }) {
  const { rows } = await runQuery(TRACK_COVERAGE_SQL, [gameNo, configKey])
  const row = rows[0] ?? {}
  return {
    count: Number(row.count ?? 0),
    maxSeq: row.max_seq === null || row.max_seq === undefined ? null : Number(row.max_seq),
    minSeq: row.min_seq === null || row.min_seq === undefined ? null : Number(row.min_seq),
  }
}

/**
 * 保证某个彩种/参数的逐期归档覆盖到最新一期。
 *
 * @returns {{status:'skipped'|'computed'|'empty', stat, written, durationMs}}
 */
export async function ensurePredictionTrack({
  runQuery,
  game,
  configKey,
  full = false,
  source = 'cli',
  log = null,
}) {
  if (!game || !game.is_positional) {
    return { status: 'skipped', reason: 'not-positional', stat: null, written: 0, durationMs: 0 }
  }

  const startedAt = performance.now()
  const draws = await loadDraws(runQuery, game.game_no)
  if (draws.length === 0) {
    return { status: 'empty', reason: 'no-draws', stat: null, written: 0, durationMs: 0 }
  }

  const latest = draws[0]
  const stat = await readTrackStat(runQuery, { gameNo: game.game_no, configKey })
  const coverage = await readTrackCoverage(runQuery, { gameNo: game.game_no, configKey })
  const engineMatches =
    Boolean(stat) &&
    stat.engineVersion === ANALYSIS_ENGINE.version &&
    stat.engineDigest === ANALYSIS_ENGINE.digest &&
    stat.payload?.version === PREDICTION_TRACK_VERSION
  const dataConsistent = Boolean(stat) && stat.trackMaxSeq === coverage.maxSeq
  const upToDate =
    engineMatches &&
    dataConsistent &&
    stat.throughIssueSeq >= latest.issueSeq &&
    stat.trackMaxSeq === stat.throughIssueSeq

  if (!full && upToDate) {
    return {
      status: 'skipped',
      stat,
      written: 0,
      durationMs: Math.round(performance.now() - startedAt),
    }
  }

  const incremental =
    !full &&
    engineMatches &&
    dataConsistent &&
    Boolean(stat.state?.counters) &&
    Array.isArray(stat.state?.recent)
  const sinceSeq = incremental ? stat.throughIssueSeq : 0
  const options = {
    ...parsePredictionConfigKey(configKey),
    positionCount: game.main_count ?? 5,
    sinceSeq,
    counters: incremental ? stat.state?.counters : null,
    recent: incremental ? stat.state?.recent : null,
  }

  const track = buildPredictionTrack(draws, options)
  let written = 0

  if (track.items.length > 0) {
    // 只写新区间；full 模式下 items 覆盖全部历史，按批写
    written = await saveTrackItems(runQuery, {
      gameNo: game.game_no,
      configKey,
      items: track.items,
      engine: ANALYSIS_ENGINE,
    })
  }

  if (track.counters.samples === 0) {
    log?.(`[track] ${game.game_key} ${configKey} 样本不足，暂不写归档`)
    return { status: 'empty', reason: 'not-enough-samples', stat: null, written, durationMs: 0 }
  }

  const previousSample = incremental ? stat.payload?.sample : null
  const sample = buildSample({ game, track, previousSample })
  const payload = buildTrackStat({
    counters: track.counters,
    recent: track.recent,
    positionCount: game.main_count ?? 5,
    configKey,
    sample,
    trackVersion: PREDICTION_TRACK_VERSION,
  })

  await runQuery(TRACK_STAT_UPSERT_SQL, [
    game.game_no,
    configKey,
    sample.toIssue,
    sample.toIssueSeq,
    payload.overall.samples,
    JSON.stringify(payload),
    JSON.stringify({ counters: track.counters, recent: track.recent }),
    ANALYSIS_ENGINE.version,
    ANALYSIS_ENGINE.digest,
  ])

  const durationMs = Math.round(performance.now() - startedAt)
  log?.(
    `[track] ${game.game_key} ${configKey} ${incremental ? '增量' : '全量'} ` +
      `${track.items.length} 期 · 归档 ${payload.overall.samples} 期 · ` +
      `Top3 ${(payload.overall.top3Rate * 100).toFixed(1)}% · ${durationMs}ms（${source}）`,
  )

  return {
    status: 'computed',
    stat: {
      ...(stat ?? {}),
      throughIssue: sample.toIssue,
      throughIssueSeq: sample.toIssueSeq,
      samples: payload.overall.samples,
      payload,
      engineVersion: ANALYSIS_ENGINE.version,
      engineDigest: ANALYSIS_ENGINE.digest,
      latestIssueSeq: latest.issueSeq,
      trackMaxSeq: sample.toIssueSeq,
    },
    written,
    durationMs,
  }
}

/** 爬虫入口：按 gameKey 解析彩种后补齐 */
export async function refreshPredictionTrack({
  runQuery,
  gameKey,
  configKey,
  source = 'crawler',
  full = false,
  log = null,
}) {
  const game = await loadGameRow(runQuery, gameKey)
  if (!game) {
    return { status: 'skipped', reason: 'unknown-game', stat: null, written: 0, durationMs: 0 }
  }
  return ensurePredictionTrack({ runQuery, game, configKey, source, full, log })
}

async function saveTrackItems(runQuery, { gameNo, configKey, items, engine }) {
  let written = 0
  for (let offset = 0; offset < items.length; offset += WRITE_CHUNK_SIZE) {
    const batch = items.slice(offset, offset + WRITE_CHUNK_SIZE)
    const columns = TRACK_COLUMNS.map((column) => batch.map((item) => trackColumnValue(column, item, {
      gameNo,
      configKey,
      engine,
    })))
    await runQuery(TRACK_UPSERT_SQL, columns)
    written += batch.length
  }
  return written
}

function trackColumnValue(column, item, context) {
  switch (column) {
    case 'game_no':
      return context.gameNo
    case 'config_key':
      return context.configKey
    case 'issue':
      return item.issue
    case 'issue_seq':
      return item.issueSeq
    case 'draw_date':
      return item.drawDate
    case 'through_issue':
      return item.throughIssue
    case 'through_issue_seq':
      return item.throughIssueSeq
    case 'actual':
      return JSON.stringify(item.actual)
    case 'positions':
      return JSON.stringify(item.positions)
    case 'combinations':
      return JSON.stringify(item.combinations)
    case 'top1_hits':
      return item.top1Hits
    case 'top3_hits':
      return item.top3Hits
    case 'best_combo_match':
      return item.bestComboMatch
    case 'engine_version':
      return context.engine.version
    case 'engine_digest':
      return context.engine.digest
    default:
      throw new Error(`未知归档列：${column}`)
  }
}

function buildSample({ game, track, previousSample }) {
  const first = track.firstTracked
  const last = track.lastTracked
  return {
    gameKey: game.game_key,
    positionCount: track.positionCount,
    fromIssue: previousSample?.fromIssue ?? first?.issue ?? null,
    fromIssueSeq: previousSample?.fromIssueSeq ?? first?.issueSeq ?? null,
    fromDrawDate: previousSample?.fromDrawDate ?? first?.drawDate ?? null,
    toIssue: last?.issue ?? previousSample?.toIssue ?? null,
    toIssueSeq: last?.issueSeq ?? previousSample?.toIssueSeq ?? null,
    toDrawDate: last?.drawDate ?? previousSample?.toDrawDate ?? null,
    drawCount: track.counters.samples,
  }
}

function toTrackItem(row) {
  return {
    issue: row.issue,
    issueSeq: Number(row.issue_seq),
    drawDate: row.draw_date,
    throughIssue: row.through_issue,
    throughIssueSeq:
      row.through_issue_seq === null || row.through_issue_seq === undefined
        ? null
        : Number(row.through_issue_seq),
    actual: Array.isArray(row.actual) ? row.actual.map(Number) : [],
    positions: Array.isArray(row.positions) ? row.positions : [],
    combinations: Array.isArray(row.combinations) ? row.combinations : [],
    top1Hits: Number(row.top1_hits),
    top3Hits: Number(row.top3_hits),
    bestComboMatch: Number(row.best_combo_match),
  }
}

function toIso(value) {
  if (!value) {
    return null
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
