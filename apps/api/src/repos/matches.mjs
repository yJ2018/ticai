import { query } from '../db.mjs'
import { createTtlCache } from '../lib.mjs'
import { toMatchEnvelope } from '../reshape.mjs'

/**
 * 在售赛事：库 → 体彩信封。
 *
 * 只要一行的最新赔率：`left join lateral` 走 (match_id, captured_at desc) 索引，
 * 100 场也就 100 次索引探测，比 `distinct on` 扫全表稳。
 */

const cache = createTtlCache({ ttlMs: 15_000, maxEntries: 2 })

const MATCHES_SQL = `
  select
    m.sporttery_match_id,
    to_char(
      coalesce(m.business_date, (m.kickoff_at at time zone 'Asia/Shanghai')::date),
      'YYYY-MM-DD'
    ) as business_date,
    m.match_num_str,
    to_char(m.kickoff_at at time zone 'Asia/Shanghai', 'HH24:MI:SS') as match_time,
    m.league_name,
    ht.sporttery_id  as home_team_sporttery_id,
    awt.sporttery_id as away_team_sporttery_id,
    m.home_name,
    m.away_name,
    max(m.last_seen_at) over () as last_seen_at,
    o.odds
  from match m
  join team ht  on ht.id  = m.home_team_id
  join team awt on awt.id = m.away_team_id
  left join lateral (
    select s.odds
    from match_odds_snapshot s
    where s.match_id = m.id
    order by s.captured_at desc
    limit 1
  ) o on true
  where m.sell_status = 'on_sale'
  order by business_date, m.kickoff_at
  limit 500
`

export async function getMatches(config) {
  const cached = cache.get('on_sale')
  if (cached) {
    return { ...cached, cache: 'hit' }
  }

  const { rows } = await query(config, MATCHES_SQL)
  const dataAsOf = rows[0]?.last_seen_at ?? null

  const result = {
    payload: toMatchEnvelope(rows),
    dataAsOf: dataAsOf ? new Date(dataAsOf).toISOString() : null,
    count: rows.length,
  }

  cache.set('on_sale', result)
  return { ...result, cache: 'miss' }
}
