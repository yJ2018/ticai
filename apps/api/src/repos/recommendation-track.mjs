import { ANALYSIS_ENGINE, loadDraws, loadGameRow } from '../analysis/compute.mjs'
import {
  RECOMMENDATION_MIN_TRAINING,
  RECOMMENDATION_TRACK_LIMIT,
  RECOMMENDATION_TRACK_VERSION,
  buildRecommendationHitStat,
  buildRecommendationTrack,
  recommendationKindForGame,
} from '../analysis/recommendation-track.mjs'

/**
 * 号码池型推荐命中归档的读写层。
 *
 *   lottery_draw（全量） → buildRecommendationTrack（walk-forward） →
 *   lottery_recommendation_track（每期一行，可回看） +
 *   lottery_recommendation_track_stat（累计 / 窗口 / 奖级分布）
 *
 * 增量策略与位次型归档一致：
 *   - 已归档到 issue N、库里多了 N+1 → 只对 N+1 做一次推荐，累计计数从 stat.state 续算；
 *   - 归档缺失 / 算法指纹变了 → 只回填最近 300 期（不做全量重算）；
 *   - 写入按 500 行一批 unnest，跨境库不会因为几百次往返卡死。
 *
 * 调用方：爬虫开奖入库后、scripts/backfill-recommendation-track.mjs、API 缺失时兜底。
 */

const TRACK_COLUMNS = [
  'game_no',
  'config_key',
  'kind',
  'issue',
  'issue_seq',
  'draw_date',
  'through_issue',
  'through_issue_seq',
  'prediction',
  'actual',
  'hits',
  'ticket',
  'engine_version',
  'engine_digest',
]

const TRACK_TYPES = [
  'text[]',
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
  'jsonb[]',
  'text[]',
  'text[]',
]

const TRACK_UPSERT_SQL = `
  insert into lottery_recommendation_track (${TRACK_COLUMNS.join(', ')})
  select * from unnest(
    ${TRACK_TYPES.map((type, index) => `$${index + 1}::${type}`).join(', ')}
  )
  on conflict (game_no, config_key, issue) do update set
    issue_seq         = excluded.issue_seq,
    draw_date         = excluded.draw_date,
    through_issue     = excluded.through_issue,
    through_issue_seq = excluded.through_issue_seq,
    prediction        = excluded.prediction,
    actual            = excluded.actual,
    hits              = excluded.hits,
    ticket            = excluded.ticket,
    engine_version    = excluded.engine_version,
    engine_digest     = excluded.engine_digest,
    computed_at       = now()
`

const TRACK_STAT_UPSERT_SQL = `
  insert into lottery_recommendation_track_stat (
    game_no, config_key, kind, through_issue, through_issue_seq, samples,
    payload, state, engine_version, engine_digest
  ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
  on conflict (game_no, config_key) do update set
    kind              = excluded.kind,
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
    s.kind,
    s.through_issue,
    s.through_issue_seq,
    s.samples,
    s.payload,
    s.state,
    s.engine_version,
    s.engine_digest,
    s.computed_at,
    (select max(issue_seq) from lottery_recommendation_track t
      where t.game_no = s.game_no and t.config_key = s.config_key) as track_max_seq,
    (select max(issue_seq) from lottery_draw d where d.game_no = s.game_no) as latest_issue_seq
  from lottery_recommendation_track_stat s
  where s.game_no = $1 and s.config_key = $2
`

const TRACK_ITEMS_SQL = `
  select
    issue,
    issue_seq,
    to_char(draw_date, 'YYYY-MM-DD') as draw_date,
    through_issue,
    through_issue_seq,
    prediction,
    actual,
    hits,
    ticket
  from lottery_recommendation_track
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
    prediction,
    actual,
    hits,
    ticket
  from lottery_recommendation_track
  where game_no = $1 and config_key = $2 and issue = any($3::text[])
  order by issue_seq desc
`

const TRACK_COVERAGE_SQL = `
  select count(*)::int as count, max(issue_seq) as max_seq, min(issue_seq) as min_seq
  from lottery_recommendation_track
  where game_no = $1 and config_key = $2
`

const WRITE_CHUNK_SIZE = 500

export async function readRecommendationTrackStat(runQuery, { gameNo, configKey }) {
  const { rows } = await runQuery(TRACK_STAT_SQL, [gameNo, configKey])
  const row = rows[0]
  if (!row) {
    return null
  }
  return {
    gameNo: row.game_no,
    configKey: row.config_key,
    kind: row.kind,
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

export async function readRecommendationTrackItems(
  runQuery,
  { gameNo, configKey, issues = null, limit = 40 },
) {
  const { rows } = Array.isArray(issues) && issues.length > 0
    ? await runQuery(TRACK_ITEMS_BY_ISSUES_SQL, [gameNo, configKey, issues])
    : await runQuery(TRACK_ITEMS_SQL, [gameNo, configKey, Math.min(Math.max(limit, 1), 500)])

  return rows.map(toTrackItem)
}

export async function readRecommendationTrackCoverage(runQuery, { gameNo, configKey }) {
  const { rows } = await runQuery(TRACK_COVERAGE_SQL, [gameNo, configKey])
  const row = rows[0] ?? {}
  return {
    count: Number(row.count ?? 0),
    maxSeq: row.max_seq === null || row.max_seq === undefined ? null : Number(row.max_seq),
    minSeq: row.min_seq === null || row.min_seq === undefined ? null : Number(row.min_seq),
  }
}

/**
 * 保证某个彩种的推荐命中归档覆盖到最新一期。
 *
 * @returns {{status:'skipped'|'computed'|'empty', stat, written, durationMs}}
 */
export async function ensureRecommendationTrack({
  runQuery,
  game,
  configKey,
  full = false,
  limit = RECOMMENDATION_TRACK_LIMIT,
  source = 'cli',
  log = null,
}) {
  const kind = game ? recommendationKindForGame(game) : null
  if (!kind) {
    return { status: 'skipped', reason: 'unsupported-game', stat: null, written: 0, durationMs: 0 }
  }

  const startedAt = performance.now()
  const draws = await loadDraws(runQuery, game.game_no)
  if (draws.length === 0) {
    return { status: 'empty', reason: 'no-draws', stat: null, written: 0, durationMs: 0 }
  }

  const latest = draws[0]
  const stat = await readRecommendationTrackStat(runQuery, {
    gameNo: game.game_no,
    configKey,
  })
  const coverage = await readRecommendationTrackCoverage(runQuery, {
    gameNo: game.game_no,
    configKey,
  })
  const engineMatches =
    Boolean(stat) &&
    stat.engineVersion === ANALYSIS_ENGINE.version &&
    stat.engineDigest === ANALYSIS_ENGINE.digest &&
    stat.payload?.version === RECOMMENDATION_TRACK_VERSION
  const dataConsistent = Boolean(stat) && stat.trackMaxSeq === coverage.maxSeq
  // 回填历史开奖后，归档可能只覆盖了最早那一小段；要补到最近 limit 期
  const expectedCoverage = Math.max(0, Math.min(limit, draws.length - RECOMMENDATION_MIN_TRAINING))
  const coverageComplete = coverage.count >= expectedCoverage
  const upToDate =
    engineMatches &&
    dataConsistent &&
    coverageComplete &&
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
    coverageComplete &&
    Boolean(stat.state?.counters) &&
    Array.isArray(stat.state?.recent)
  const sinceSeq = incremental ? stat.throughIssueSeq : 0

  const track = buildRecommendationTrack(draws, {
    game,
    kind,
    limit,
    sinceSeq,
    counters: incremental ? stat.state?.counters : null,
    recent: incremental ? stat.state?.recent : null,
  })

  let written = 0
  if (track.items.length > 0) {
    if (full) {
      await runQuery(
        'delete from lottery_recommendation_track where game_no = $1 and config_key = $2',
        [game.game_no, configKey],
      )
    }
    written = await saveTrackItems(runQuery, {
      gameNo: game.game_no,
      configKey,
      kind,
      items: track.items,
      engine: ANALYSIS_ENGINE,
    })
  }

  if (track.counters.samples === 0) {
    log?.(`[hits] ${game.game_key} ${configKey} 样本不足，暂不写归档`)
    return { status: 'empty', reason: 'not-enough-samples', stat: null, written, durationMs: 0 }
  }

  const previousSample = incremental ? stat.payload?.sample : null
  const sample = {
    gameKey: game.game_key,
    kind,
    fromIssue: previousSample?.fromIssue ?? track.firstTracked?.issue ?? null,
    fromIssueSeq: previousSample?.fromIssueSeq ?? track.firstTracked?.issueSeq ?? null,
    fromDrawDate: previousSample?.fromDrawDate ?? track.firstTracked?.drawDate ?? null,
    toIssue: track.lastTracked?.issue ?? previousSample?.toIssue ?? null,
    toIssueSeq: track.lastTracked?.issueSeq ?? previousSample?.toIssueSeq ?? null,
    toDrawDate: track.lastTracked?.drawDate ?? previousSample?.toDrawDate ?? null,
    drawCount: track.counters.samples,
  }
  const payload = buildRecommendationHitStat({
    counters: track.counters,
    recent: track.recent,
    game,
    kind,
    configKey,
    sample,
  })

  await runQuery(TRACK_STAT_UPSERT_SQL, [
    game.game_no,
    configKey,
    kind,
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
    `[hits] ${game.game_key} ${configKey} ${incremental ? '增量' : '回填'} ` +
      `${track.items.length} 期 · 归档 ${payload.overall.samples} 期 · ` +
      `平均命中 ${payload.overall.avgMainHits.toFixed(2)}/${game.main_count} · ${durationMs}ms（${source}）`,
  )

  return {
    status: 'computed',
    stat: {
      ...(stat ?? {}),
      kind,
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
export async function refreshRecommendationTrack({
  runQuery,
  gameKey,
  configKey,
  source = 'crawler',
  full = false,
  limit = RECOMMENDATION_TRACK_LIMIT,
  log = null,
}) {
  const game = await loadGameRow(runQuery, gameKey)
  if (!game) {
    return { status: 'skipped', reason: 'unknown-game', stat: null, written: 0, durationMs: 0 }
  }
  return ensureRecommendationTrack({ runQuery, game, configKey, source, full, limit, log })
}

async function saveTrackItems(runQuery, { gameNo, configKey, kind, items, engine }) {
  let written = 0
  for (let offset = 0; offset < items.length; offset += WRITE_CHUNK_SIZE) {
    const batch = items.slice(offset, offset + WRITE_CHUNK_SIZE)
    const columns = TRACK_COLUMNS.map((column) =>
      batch.map((item) =>
        trackColumnValue(column, item, { gameNo, configKey, kind, engine }),
      ),
    )
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
    case 'kind':
      return context.kind
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
    case 'prediction':
      return JSON.stringify(item.prediction)
    case 'actual':
      return JSON.stringify(item.actual)
    case 'hits':
      return JSON.stringify(item.hits)
    case 'ticket':
      return JSON.stringify(item.ticket)
    case 'engine_version':
      return context.engine.version
    case 'engine_digest':
      return context.engine.digest
    default:
      throw new Error(`未知归档列：${column}`)
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
    prediction: row.prediction ?? {},
    actual: row.actual ?? {},
    hits: row.hits ?? {},
    ticket: row.ticket ?? {},
  }
}

function toIso(value) {
  if (!value) {
    return null
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
