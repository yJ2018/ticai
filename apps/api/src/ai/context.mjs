import { query } from '../db.mjs'

/**
 * 分析所需的数据装配：比赛 + 最新赔率 + 对战数据快照 + 天气。
 *
 * 客户端只给 matchId，其余全部由这里补齐，避免前端把一大堆结构化数据
 * 重新拼进请求体（那样既费流量又容易和库里不一致）。
 */

const MATCH_SQL = `
  select sporttery_match_id, match_num_str, league_name, home_name, away_name,
         kickoff_at, status, home_team_id, away_team_id
  from match
  where sporttery_match_id = $1
`

const ODDS_SQL = `
  select s.odds
  from match_odds_snapshot s
  join match m on m.id = s.match_id
  where m.sporttery_match_id = $1
  order by s.captured_at desc
  limit 1
`

const FEED_SQL = `select feed, payload from match_feed where sporttery_match_id = $1`

const LINEUP_SQL = `
  select ml.team_id, ml.formation, ml.confirmed, p.name, mlp.is_starter
  from match_lineup ml
  join match m on m.id = ml.match_id
  join match_lineup_player mlp
    on mlp.match_id = ml.match_id and mlp.team_id = ml.team_id
  join player p on p.id = mlp.player_id
  where m.sporttery_match_id = $1
  order by ml.team_id, mlp.is_starter desc, p.name
`

/** 阵容只取首发与阵型，够提示词用即可。 */
function shapeLineup(rows, match) {
  if (!rows || rows.length === 0) {
    return null
  }

  const build = (teamId) => {
    const teamRows = rows.filter((row) => String(row.team_id) === String(teamId))
    if (teamRows.length === 0) {
      return null
    }
    return {
      formation: teamRows[0].formation ?? null,
      confirmed: teamRows[0].confirmed === true,
      starters: teamRows
        .filter((row) => row.is_starter === true)
        .map((row) => row.name)
        .filter(Boolean),
    }
  }

  const home = build(match.homeTeamId)
  const away = build(match.awayTeamId)
  return home || away ? { home, away } : null
}

export async function loadMatchContext(config, matchId) {
  const { rows } = await query(config, MATCH_SQL, [matchId])
  if (rows.length === 0) {
    return null
  }

  const row = rows[0]
  const [oddsResult, feedResult, lineupResult] = await Promise.all([
    query(config, ODDS_SQL, [matchId]),
    query(config, FEED_SQL, [matchId]),
    query(config, LINEUP_SQL, [matchId]),
  ])

  const feeds = {}
  for (const feed of feedResult.rows) {
    feeds[feed.feed] = feed.payload
  }

  const match = {
    matchNo: row.match_num_str,
    league: row.league_name,
    homeName: row.home_name,
    awayName: row.away_name,
    kickoffAt: row.kickoff_at ? new Date(row.kickoff_at).toISOString() : null,
    status: row.status,
    homeTeamId: row.home_team_id,
    awayTeamId: row.away_team_id,
  }

  return {
    match,
    odds: oddsResult.rows[0]?.odds ?? null,
    feeds,
    lineup: shapeLineup(lineupResult.rows, match),
  }
}

/**
 * 天气是增强信息：最多等 timeoutMs，失败一律当"没有"，
 * 绝不能让它在分析主链路上拖着。
 */
export async function loadWeather(venueService, match, timeoutMs = 5_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await venueService.get({
      homeTeam: match.homeName,
      league: match.league,
      kickoff: match.kickoffAt ?? '',
      signal: controller.signal,
    })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
