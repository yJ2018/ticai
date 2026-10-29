import { query } from '../db.mjs'

/**
 * 推荐引擎的数据层：只读 SQL，不在这一层做任何取舍。
 *
 * 数据口径（2026-10 实测）：
 *   - 在售赛事：19 场左右，全部有最新赔率（5 个玩法）；
 *   - 伤停 feed：`match_feed.injury`，覆盖部分场次（爬虫默认只抓这一路）；
 *   - 历史战绩：`match` 里 status='finished' 且有比分（近两周约 111 场，样本很薄）；
 *   - 回测样本：`match_result` × 赛前赔率快照（111 场），这是目前唯一能自证的数据。
 */

const SLATE_SQL = `
  select
    m.sporttery_match_id,
    m.match_num_str,
    m.league_name,
    m.home_name,
    m.away_name,
    m.kickoff_at,
    to_char(
      coalesce(m.business_date, (m.kickoff_at at time zone 'Asia/Shanghai')::date),
      'YYYY-MM-DD'
    ) as business_date,
    m.home_team_id,
    m.away_team_id,
    s.odds,
    s.captured_at as odds_captured_at
  from match m
  left join lateral (
    select s2.odds, s2.captured_at
    from match_odds_snapshot s2
    where s2.match_id = m.id
    order by s2.captured_at desc
    limit 1
  ) s on true
  where m.sell_status = 'on_sale'
  order by m.kickoff_at
  limit 500
`

export async function loadSlate(config) {
  const { rows } = await query(config, SLATE_SQL)
  return rows.map((row) => ({
    matchId: Number(row.sporttery_match_id),
    matchNo: row.match_num_str ?? '',
    league: row.league_name ?? '',
    homeName: row.home_name ?? '',
    awayName: row.away_name ?? '',
    kickoffAt: row.kickoff_at ? new Date(row.kickoff_at).toISOString() : null,
    businessDate: row.business_date ?? '',
    homeTeamId: row.home_team_id === null ? null : Number(row.home_team_id),
    awayTeamId: row.away_team_id === null ? null : Number(row.away_team_id),
    odds: row.odds && typeof row.odds === 'object' ? row.odds : null,
    oddsCapturedAt: row.odds_captured_at ? new Date(row.odds_captured_at).toISOString() : null,
  }))
}

/** 伤停：每场取最新一条 feed，返回两队的人数与球员名。 */
export async function loadInjuries(config, matchIds) {
  if (matchIds.length === 0) {
    return new Map()
  }
  const { rows } = await query(
    config,
    `select distinct on (sporttery_match_id) sporttery_match_id, payload, fetched_at
     from match_feed
     where feed = 'injury' and sporttery_match_id = any($1::bigint[])
     order by sporttery_match_id, fetched_at desc`,
    [matchIds],
  )

  const map = new Map()
  for (const row of rows) {
    const payload = row.payload ?? {}
    const side = (value) => {
      const list = value?.injuriesAndSuspensionsList
      if (!Array.isArray(list)) {
        return { count: 0, names: [] }
      }
      return {
        count: list.length,
        names: list
          .map((item) => item?.playerName ?? item?.personName ?? item?.name ?? '')
          .filter(Boolean)
          .slice(0, 4),
      }
    }
    map.set(Number(row.sporttery_match_id), {
      home: side(payload.home),
      away: side(payload.away),
      fetchedAt: row.fetched_at ? new Date(row.fetched_at).toISOString() : null,
    })
  }
  return map
}

/** 历史战绩（同内部 team_id 口径）：给 λ 做有界修正 + 写理由。 */
export async function loadFinishedMatches(config) {
  const { rows } = await query(
    config,
    `select id, sporttery_match_id, kickoff_at, home_team_id, away_team_id, home_score, away_score, league_name
     from match
     where status = 'finished' and home_score is not null and away_score is not null
     order by kickoff_at desc
     limit 2000`,
  )

  return rows.map((row) => ({
    id: Number(row.id),
    matchId: Number(row.sporttery_match_id),
    kickoffAt: new Date(row.kickoff_at).toISOString(),
    homeTeamId: row.home_team_id === null ? null : Number(row.home_team_id),
    awayTeamId: row.away_team_id === null ? null : Number(row.away_team_id),
    homeScore: Number(row.home_score),
    awayScore: Number(row.away_score),
    league: row.league_name ?? '',
  }))
}

/**
 * 回测样本：已开奖 + 开赛前就有赔率快照。
 *
 * 只用「开赛前最后一次快照」：赛后赔率会收敛到结果，拿来做回测等于作弊。
 */
export async function loadBacktestSamples(config) {
  const { rows } = await query(
    config,
    `select
       r.sporttery_match_id,
       r.match_date,
       r.goal_line,
       r.had_result,
       r.hhad_result,
       r.ttg_result,
       r.full_home,
       r.full_away,
       m.kickoff_at,
       m.league_name,
       m.home_name,
       m.away_name,
       (
         select s.odds
         from match_odds_snapshot s
         where s.match_id = m.id
           and s.captured_at <= coalesce(m.kickoff_at, now())
         order by s.captured_at desc
         limit 1
       ) as odds
     from match_result r
     join match m on m.sporttery_match_id = r.sporttery_match_id
     where r.had_result is not null
     order by m.kickoff_at`,
  )

  return rows
    .filter((row) => row.odds && typeof row.odds === 'object')
    .map((row) => ({
      matchId: Number(row.sporttery_match_id),
      matchDate: row.match_date ? new Date(row.match_date).toISOString().slice(0, 10) : '',
      kickoffAt: row.kickoff_at ? new Date(row.kickoff_at).toISOString() : null,
      league: row.league_name ?? '',
      homeName: row.home_name ?? '',
      awayName: row.away_name ?? '',
      goalLine: Number(row.goal_line ?? 0),
      hadResult: row.had_result ?? null,
      hhadResult: row.hhad_result ?? null,
      ttgResult: row.ttg_result === null || row.ttg_result === undefined ? null : Number(row.ttg_result),
      fullHome: Number(row.full_home ?? 0),
      fullAway: Number(row.full_away ?? 0),
      odds: row.odds,
    }))
}
