import { query } from '../db.mjs'
import { HttpError, sendData } from '../lib.mjs'
import { buildMatchDetail } from '../match-detail.mjs'

/**
 * 对战详情：参考 m.sporttery.cn/zqlszl/bssj 的 7 个板块 + 阵容。
 *
 * 数据来自爬虫写入的 match_feed（原始上游 JSON）+ match（比分/半场）
 * + match_lineup / match_lineup_player（阵容，来源无关的导入）。
 * 没有抓到的板块返回 null，空分组保留空数组，不编造。
 */

const MATCH_SQL = `
  select id, sporttery_match_id, league_name, kickoff_at, status, sell_status,
         home_name, away_name, home_score, away_score,
         home_half_score, away_half_score, htft, result_source,
         home_team_id, away_team_id
  from match
  where sporttery_match_id = $1
`

const FEED_SQL = `
  select feed, payload, fetched_at
  from match_feed
  where sporttery_match_id = $1
`

const LINEUP_SQL = `
  select ml.team_id, ml.formation, ml.coach, ml.confirmed, ml.source, ml.captured_at,
         p.name, mlp.is_starter, mlp.position, mlp.shirt_no
  from match_lineup ml
  join match m on m.id = ml.match_id
  join match_lineup_player mlp
    on mlp.match_id = ml.match_id and mlp.team_id = ml.team_id
  join player p on p.id = mlp.player_id
  where m.sporttery_match_id = $1
  order by ml.team_id, mlp.is_starter desc, mlp.shirt_no nulls last, p.name
`

/** 把扁平的 join 结果整理成 { home, away } 两个队。 */
function shapeLineup(rows, match) {
  if (!rows || rows.length === 0) {
    return null
  }

  const build = (teamId, fallbackName) => {
    const teamRows = rows.filter((row) => String(row.team_id) === String(teamId))
    if (teamRows.length === 0) {
      return null
    }
    const head = teamRows[0]
    const toPlayer = (row) => ({
      name: row.name,
      number: row.shirt_no === null || row.shirt_no === undefined ? null : Number(row.shirt_no),
      position: row.position ?? null,
      starter: row.is_starter === true,
    })
    return {
      teamName: fallbackName,
      formation: head.formation ?? null,
      coach: head.coach ?? null,
      confirmed: head.confirmed === true,
      source: head.source ?? null,
      capturedAt: head.captured_at ? new Date(head.captured_at).toISOString() : null,
      starters: teamRows.filter((row) => row.is_starter === true).map(toPlayer),
      substitutes: teamRows.filter((row) => row.is_starter !== true).map(toPlayer),
    }
  }

  const home = build(match.home_team_id, match.home_name)
  const away = build(match.away_team_id, match.away_name)
  if (!home && !away) {
    return null
  }
  return { home, away }
}

export function createMatchDetailHandler(config) {
  return async function matchDetail(ctx) {
    const raw = ctx.url.searchParams.get('matchId') ?? ''
    if (!/^\d{4,12}$/.test(raw)) {
      throw new HttpError(400, 'matchId 参数不合法')
    }

    const { rows: matches } = await query(config, MATCH_SQL, [raw])
    if (matches.length === 0) {
      throw new HttpError(404, `没有这场比赛：${raw}`)
    }

    const match = matches[0]
    const [{ rows: feeds }, { rows: lineupRows }] = await Promise.all([
      query(config, FEED_SQL, [raw]),
      query(config, LINEUP_SQL, [raw]),
    ])

    const detail = buildMatchDetail({ match, feeds })
    detail.lineup = shapeLineup(lineupRows, match)
    if (!detail.lineup) {
      detail.missing = [...detail.missing, 'lineup']
    }

    sendData(ctx.res, detail, { 'x-request-id': ctx.requestId })
  }
}
