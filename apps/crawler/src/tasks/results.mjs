import { finishRun, startRun } from '../db.mjs'
import { sleep } from '../http.mjs'
import { normalizeMatchResult } from '../normalize.mjs'
import { fetchMatchResults } from '../sporttery.mjs'

/**
 * 竞彩足球赛果开奖：一次请求拿一批比赛的结果，替代「逐场抓近期赛果」。
 *
 * 为什么单独一条链路：
 *   - 官网赛果开奖接口按日期区间分页，一天的全部场次通常 1~2 页就拿完；
 *   - details 里那个「近期赛果」是球队视角，每场要一个请求，49 场就是 49 次；
 *   - 开奖发生在赛后（19 点后结束的比赛第二天早上开奖），和销售时段无关，
 *     所以这条链路不过销售时段闸门。
 */

const UPSERT_RESULT = `
  insert into match_result (
    sporttery_match_id, match_id, match_num_str, match_date, league_id, league_name,
    home_name, away_name, home_team_id, away_team_id,
    half_home, half_away, full_home, full_away, goal_line,
    had_result, hhad_result, ttg_result, crs_result, hafu_result,
    win_flag, pool_status, result_status, settled, settled_at, raw
  )
  values (
    $1, (select id from match where sporttery_match_id = $1), $2, $3, $4, $5,
    $6, $7, $8, $9,
    $10, $11, $12, $13, $14,
    $15, $16, $17, $18, $19,
    $20, $21, $22, $23, case when $23 then now() else null end, $24
  )
  on conflict (sporttery_match_id) do update set
    match_id      = coalesce(match_result.match_id, excluded.match_id),
    match_num_str = coalesce(excluded.match_num_str, match_result.match_num_str),
    match_date    = coalesce(excluded.match_date, match_result.match_date),
    league_id     = coalesce(excluded.league_id, match_result.league_id),
    league_name   = coalesce(excluded.league_name, match_result.league_name),
    home_name     = excluded.home_name,
    away_name     = excluded.away_name,
    home_team_id  = coalesce(excluded.home_team_id, match_result.home_team_id),
    away_team_id  = coalesce(excluded.away_team_id, match_result.away_team_id),
    half_home     = coalesce(excluded.half_home, match_result.half_home),
    half_away     = coalesce(excluded.half_away, match_result.half_away),
    full_home     = coalesce(excluded.full_home, match_result.full_home),
    full_away     = coalesce(excluded.full_away, match_result.full_away),
    goal_line     = coalesce(excluded.goal_line, match_result.goal_line),
    had_result    = coalesce(excluded.had_result, match_result.had_result),
    hhad_result   = coalesce(excluded.hhad_result, match_result.hhad_result),
    ttg_result    = coalesce(excluded.ttg_result, match_result.ttg_result),
    crs_result    = coalesce(excluded.crs_result, match_result.crs_result),
    hafu_result   = coalesce(excluded.hafu_result, match_result.hafu_result),
    win_flag      = excluded.win_flag,
    pool_status   = excluded.pool_status,
    result_status = excluded.result_status,
    settled       = excluded.settled or match_result.settled,
    settled_at    = coalesce(match_result.settled_at, excluded.settled_at),
    raw           = excluded.raw,
    updated_at    = now()
  where (match_result.full_home, match_result.full_away, match_result.half_home, match_result.half_away,
         match_result.goal_line, match_result.result_status, match_result.pool_status)
        is distinct from
        (excluded.full_home, excluded.full_away, excluded.half_home, excluded.half_away,
         excluded.goal_line, excluded.result_status, excluded.pool_status)
     or match_result.win_flag is distinct from excluded.win_flag
  returning sporttery_match_id
`

/** 赛果先入库、比赛后入库时，match_id 会在后续轮次补上（内容没变就不会走 upsert 的 update）。 */
const LINK_MATCH = `
  update match_result r set
    match_id   = m.id,
    updated_at = now()
  from match m
  where m.sporttery_match_id = r.sporttery_match_id
    and r.match_id is null
    and r.sporttery_match_id = any($1::bigint[])
`

/** 把开奖结果回写到 match（比分/状态），前端与老接口不用改就能看到赛果。 */
const SYNC_MATCH = `
  update match m set
    home_score      = r.full_home,
    away_score      = r.full_away,
    home_half_score = coalesce(r.half_home, m.home_half_score),
    away_half_score = coalesce(r.half_away, m.away_half_score),
    status          = 'finished',
    result_status   = 'finished',
    result_source   = 'sporttery.result_api',
    result_at       = coalesce(m.result_at, now()),
    updated_at      = now()
  from match_result r
  where m.sporttery_match_id = r.sporttery_match_id
    and r.sporttery_match_id = any($1::bigint[])
    and r.settled
    and (m.home_score      is distinct from r.full_home
      or m.away_score      is distinct from r.full_away
      or m.home_half_score is distinct from coalesce(r.half_home, m.home_half_score)
      or m.away_half_score is distinct from coalesce(r.half_away, m.away_half_score)
      or m.status <> 'finished')
`

/** 北京时间下的「今天 + offsetDays」，格式 YYYY-MM-DD。 */
export function shanghaiDate(offsetDays = 0, now = new Date()) {
  const stamp = now.getTime() + 8 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000
  return new Date(stamp).toISOString().slice(0, 10)
}

/** 把日期区间切成上游能接受的块（实测一次 8 天 ~745 场也正常，留点余量）。 */
export function splitRange(begin, end, daysPerChunk = 7) {
  const chunks = []
  const toStamp = (text) => Date.parse(`${text}T00:00:00Z`)
  const fromStamp = (stamp) => new Date(stamp).toISOString().slice(0, 10)

  let cursor = toStamp(begin)
  const last = toStamp(end)
  if (!Number.isFinite(cursor) || !Number.isFinite(last) || cursor > last) {
    return chunks
  }

  while (cursor <= last) {
    const chunkEnd = Math.min(cursor + (daysPerChunk - 1) * 24 * 60 * 60 * 1000, last)
    chunks.push({ begin: fromStamp(cursor), end: fromStamp(chunkEnd) })
    cursor = chunkEnd + 24 * 60 * 60 * 1000
  }

  return chunks
}

/**
 * 抓一批赛果。
 *
 * @param {object} options
 * @param {number} [options.days]   抓最近几天（含今天），默认 3
 * @param {string} [options.begin]  指定区间起点（回灌用）
 * @param {string} [options.end]    指定区间终点
 */
export async function crawlMatchResults({
  pool,
  config,
  days = 3,
  begin = '',
  end = '',
  pageSize = 100,
  log = console.log,
}) {
  const from = begin || shanghaiDate(-(Math.max(1, days) - 1))
  const to = end || shanghaiDate(0)
  const chunks = splitRange(from, to)
  const runId = await startRun(pool, { source: 'sporttery.results', meta: { from, to, chunks: chunks.length } })

  const summary = { from, to, requests: 0, matches: 0, changed: 0, settled: 0, linked: 0, matchesSynced: 0, failed: 0 }

  try {
    for (const chunk of chunks) {
      let pageNo = 1
      let pages = 1

      do {
        let page
        try {
          page = await fetchMatchResults(config, { begin: chunk.begin, end: chunk.end, pageNo, pageSize })
          summary.requests += 1
        } catch (error) {
          summary.failed += 1
          log(
            `  ! 赛果 ${chunk.begin}~${chunk.end} 第 ${pageNo} 页失败：` +
              (error instanceof Error ? error.message : String(error)),
          )
          break
        }

        pages = Math.max(1, page.pages)
        const ids = []

        for (const item of page.list) {
          let row
          try {
            row = normalizeMatchResult(item)
          } catch {
            continue
          }

          ids.push(row.sportteryMatchId)
          summary.matches += 1
          if (row.settled) {
            summary.settled += 1
          }

          const { rowCount } = await pool.query(UPSERT_RESULT, [
            row.sportteryMatchId,
            row.matchNumStr,
            row.matchDate,
            row.leagueId,
            row.leagueName,
            row.homeName,
            row.awayName,
            row.homeTeamId,
            row.awayTeamId,
            row.halfHome,
            row.halfAway,
            row.fullHome,
            row.fullAway,
            row.goalLine,
            row.hadResult,
            row.hhadResult,
            row.ttgResult,
            row.crsResult,
            row.hafuResult,
            row.winFlag,
            row.poolStatus,
            row.resultStatus,
            row.settled,
            row.raw,
          ])
          summary.changed += rowCount ?? 0
        }

        if (ids.length > 0) {
          const linked = await pool.query(LINK_MATCH, [ids])
          summary.linked += linked.rowCount ?? 0
          const synced = await pool.query(SYNC_MATCH, [ids])
          summary.matchesSynced += synced.rowCount ?? 0
        }

        pageNo += 1
        if (pageNo <= pages) {
          await sleep(config.delayMs)
        }
      } while (pageNo <= pages)
    }

    await finishRun(pool, runId, {
      status: 'ok',
      itemCount: summary.matches,
      changedCount: summary.changed,
    })

    return summary
  } catch (error) {
    await finishRun(pool, runId, { status: 'failed', error: error.message })
    throw error
  }
}

/**
 * 有没有「已经开赛但还没拿到赛果」的比赛。
 * 常驻爬虫用它避免空转：没有待开奖的比赛就跳过这一轮。
 */
export async function hasPendingResults(pool, { lookbackDays = 3 } = {}) {
  const { rows } = await pool.query(
    `select exists (
       select 1
       from match m
       left join match_result r on r.sporttery_match_id = m.sporttery_match_id
       where m.kickoff_at < now()
         and m.kickoff_at > now() - ($1::int * interval '1 day')
         and (r.sporttery_match_id is null or r.settled = false)
     ) as pending`,
    [lookbackDays],
  )
  return Boolean(rows[0]?.pending)
}
