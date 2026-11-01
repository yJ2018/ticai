import {
  espnLeagueSlug,
  fetchScoreboard,
  fetchSummary,
  parseEspnLineup,
  pickEvent,
  toUtcDateKey,
} from '../espn.mjs'
import { sleep } from '../http.mjs'
import { writeLineup } from './lineups.mjs'

/**
 * 用 ESPN 抓首发阵容，替代原来的 500.com + Playwright 有头浏览器。
 *
 * 为什么换：
 *   - 500.com 是 JS 渲染 + 拦截 headless，必须起有头 Chrome，机器一锁屏就抓不动；
 *   - 实测近两天阵容覆盖率只有 30/73 场，且拿不到阵型；
 *   - ESPN 的 `summary.rosters` 直接给首发/替补/位置/球衣号/阵型，赛前约 1 小时公布。
 *
 * 匹配方式：体彩联赛名 → ESPN slug；开赛时间 ±12 分钟；同一时间多场时用体彩的
 * 英文缩写对主队缩写，对不唯一就跳过。宁可少抓，不能把阵容写到别的比赛上。
 *
 * 只处理「在售 + 还没拿到 ESPN 官方名单」的比赛；窗口内没公布就下一轮再来。
 */

const SELECT_MATCHES = `
  select m.id,
         m.sporttery_match_id,
         m.league_name,
         m.kickoff_at,
         m.home_name,
         m.away_name,
         m.raw
  from match m
  where m.sell_status = 'on_sale'
    and m.status not in ('cancelled', 'finished')
    and m.kickoff_at > now() - interval '20 minutes'
    and m.kickoff_at < now() + ($1 || ' hours')::interval
    and not exists (
      select 1 from match_lineup l
      where l.match_id = m.id and l.source = 'espn' and l.confirmed = true
    )
  order by m.kickoff_at
  limit $2
`

/**
 * 抓一轮阵容。
 *
 * @param {object} input
 * @param {import('pg').Pool} input.pool
 * @param {number} [input.windowHours] 只处理这么多小时内开赛的比赛
 * @param {number} [input.limit] 单轮最多处理多少场，避免一口气打太多 ESPN 请求
 * @param {number} [input.delayMs] 两次 summary 请求之间的间隔
 * @param {boolean} [input.dryRun] 预演：写库后回滚
 */
export async function crawlLineupsEspn({
  pool,
  windowHours = 6,
  limit = 20,
  delayMs = 400,
  dryRun = false,
  fetchOptions,
  log = console.log,
} = {}) {
  const { rows: matches } = await pool.query(SELECT_MATCHES, [String(windowHours), limit])

  if (matches.length === 0) {
    log('  窗口内没有需要抓阵容的比赛')
    return { matched: 0, found: 0, skipped: 0, players: 0, dryRun }
  }

  log(`  待抓比赛 ${matches.length} 场`)

  // 同一联赛同一天只拉一次 scoreboard，避免 20 场比赛打 20 次列表接口
  const scoreboards = new Map()
  const loadEvents = async (slug, dateKey) => {
    const key = `${slug}|${dateKey}`
    if (!scoreboards.has(key)) {
      scoreboards.set(key, await fetchScoreboard(slug, dateKey, fetchOptions))
    }
    return scoreboards.get(key)
  }

  let found = 0
  let skipped = 0
  let players = 0

  for (const match of matches) {
    const label = `${match.home_name} vs ${match.away_name}`
    const slug = espnLeagueSlug(match.league_name)
    if (!slug) {
      skipped += 1
      log(`  · ${label}：联赛「${match.league_name}」没有 ESPN 映射，跳过`)
      continue
    }

    let event = null
    try {
      const events = await loadEvents(slug, toUtcDateKey(match.kickoff_at))
      event = pickEvent(
        {
          kickoffAt: match.kickoff_at,
          homeCode: match.raw?.homeTeamAbbEnName,
          awayCode: match.raw?.awayTeamAbbEnName,
        },
        events,
      )
    } catch (error) {
      skipped += 1
      log(`  ! ${label}：ESPN 赛程请求失败（${error.message}）`)
      continue
    }

    if (!event) {
      skipped += 1
      log(`  · ${label}：ESPN 没对上（${slug}）`)
      continue
    }

    let summary = null
    try {
      await sleep(delayMs)
      summary = await fetchSummary(slug, event.id, fetchOptions)
    } catch (error) {
      skipped += 1
      log(`  ! ${label}：ESPN 详情请求失败（${error.message}）`)
      continue
    }

    const lineup = parseEspnLineup(summary)
    if (!lineup) {
      skipped += 1
      log(`  · ${label}：阵容还没公布`)
      continue
    }

    try {
      const summaryWritten = await writeLineup({
        pool,
        sportteryMatchId: match.sporttery_match_id,
        home: lineup.home,
        away: lineup.away,
        source: 'espn',
        dryRun,
      })
      const saved = (summaryWritten?.home ?? 0) + (summaryWritten?.away ?? 0)
      found += 1
      players += saved
      log(
        `  ✓ ${label} 主 ${summaryWritten?.home ?? 0} 人 / 客 ${summaryWritten?.away ?? 0} 人` +
          ` · 阵型 ${lineup.home.formation ?? '-'} / ${lineup.away.formation ?? '-'}` +
          (dryRun ? '（预演）' : ''),
      )
    } catch (error) {
      skipped += 1
      log(`  ! ${label}：入库失败（${error.message}）`)
    }
  }

  return { matched: matches.length, found, skipped, players, dryRun }
}
