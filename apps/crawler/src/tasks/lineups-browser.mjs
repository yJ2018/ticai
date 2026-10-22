import { findPlayerLikeArrays, saveDump, withPage } from '../browser.mjs'
import { writeLineup } from './lineups.mjs'

/**
 * 用真实浏览器抓 500.com 的阵容。
 *
 * 两种模式：
 *   探测：--fid=xxx / --url=xxx  → dump 页面与网络响应
 *   抓取：--run                  → 按「场次号」匹配到本库比赛后入库
 *
 * 关键点：500.com 列表页每行带「周四006」这种场次号，和体彩的 matchNumStr
 * 是同一套编号，所以不需要模糊匹配队名。
 */

const DETAIL_URL = (fid) => `https://live.500.com/detail.php?fid=${fid}`
const LIST_URL = (date) => `https://live.500.com/index.php?e=${date}`

/** 在详情页里解析四个 box_side：主队首发、主队后备、客队首发、客队后备。 */
function parseDetailInPage() {
  const parseLine = (line) => {
    const text = (line || '').replace(/\s+/g, ' ').trim()
    if (!text) {
      return null
    }
    const matched = text.match(/^(\d+)\s+(.+?)(?:\(([^()]*)\))?$/)
    if (matched) {
      return { no: Number(matched[1]), name: matched[2].trim(), position: (matched[3] || '').trim() }
    }
    return { no: null, name: text, position: '' }
  }

  const readBox = (box) =>
    [...box.querySelectorAll('table tr')]
      .map((tr) => tr.querySelector('td:last-child')?.textContent || '')
      .map(parseLine)
      .filter(Boolean)

  const groups = [...document.querySelectorAll('.box_side')].map((box) => ({
    title: (box.querySelector('.title')?.textContent || '').trim(),
    players: readBox(box),
  }))

  const starters = groups.filter((group) => /首发/.test(group.title))
  const benches = groups.filter((group) => /后备|替补/.test(group.title))

  const toSide = (index) => {
    const first = starters[index]
    if (!first || first.players.length === 0) {
      return null
    }
    const bench = benches[index]
    return {
      // 500.com 只给名单，不给阵型
      formation: null,
      // 「预计首发阵容」= 预测；「首发阵容」= 官方
      confirmed: !/预计/.test(first.title),
      players: [
        ...first.players.map((player) => ({ ...player, starter: true })),
        ...(bench?.players ?? []).map((player) => ({ ...player, starter: false })),
      ],
    }
  }

  return {
    title: document.title,
    home: toSide(0),
    away: toSide(1),
    starterCounts: starters.map((group) => group.players.length),
  }
}

/** 列表页：场次号 → fid */
async function collectFidIndex(page, dates, log) {
  const index = new Map()

  for (const date of dates) {
    try {
      await page.goto(LIST_URL(date), { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await page.waitForTimeout(2_500)
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll('tr')]
          .map((tr) => {
            const link = tr.querySelector('a[href*="fid="]')
            if (!link) {
              return null
            }
            const fid = (link.getAttribute('href') || '').match(/fid=(\d+)/)?.[1]
            const text = (tr.innerText || '').replace(/\s+/g, ' ').trim()
            const matchNo = text.match(/^(周[一二三四五六日]\d{3})/)?.[1]
            return fid && matchNo ? { fid, matchNo } : null
          })
          .filter(Boolean),
      )
      for (const row of rows) {
        if (!index.has(row.matchNo)) {
          index.set(row.matchNo, row.fid)
        }
      }
      log(`  列表 ${date}: ${rows.length} 场`)
    } catch (error) {
      log(`  列表 ${date} 失败: ${error.message}`)
    }
  }

  return index
}

function toDateString(value) {
  const date = value instanceof Date ? value : new Date(value)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}

function shiftDate(dateString, days) {
  const date = new Date(`${dateString}T12:00:00+08:00`)
  date.setUTCDate(date.getUTCDate() + days)
  return toDateString(date)
}

/**
 * 抓一轮阵容。
 *
 * 阵容通常赛前 1 小时左右才公布，所以窗口取「开赛前后各 N 小时」，
 * 每轮只处理窗口里、且还没拿到官方名单的比赛。
 */
export async function crawlLineupsBrowser({
  pool,
  windowHours = 6,
  limit = 15,
  dryRun = false,
  log = console.log,
}) {
  const { rows: matches } = await pool.query(
    `select m.sporttery_match_id, m.match_num_str, m.business_date, m.kickoff_at,
            m.home_name, m.away_name
     from match m
     where m.match_num_str is not null
       and m.sell_status = 'on_sale'
       and m.status not in ('cancelled', 'finished')
       and m.kickoff_at > now()
       and m.kickoff_at < now() + ($1 || ' hours')::interval
       and not exists (
         select 1 from match_lineup l
         where l.match_id = m.id and l.confirmed = true
       )
     order by m.kickoff_at
     limit $2`,
    [String(windowHours), limit],
  )

  if (matches.length === 0) {
    log('  窗口内没有需要抓阵容的比赛')
    return { matched: 0, found: 0, skipped: 0, players: 0 }
  }

  log(`  待抓比赛 ${matches.length} 场`)

  return withPage(async (page) => {
    const dates = [...new Set(matches.flatMap((match) => {
      const base = toDateString(match.kickoff_at)
      return [shiftDate(base, -1), base, shiftDate(base, 1)]
    }))].sort()

    const fidIndex = await collectFidIndex(page, dates, log)
    log(`  列表共 ${fidIndex.size} 个场次号`)

    let found = 0
    let skipped = 0
    let players = 0

    for (const match of matches) {
      const fid = fidIndex.get((match.match_num_str || '').trim())
      if (!fid) {
        skipped += 1
        log(`  ! ${match.match_num_str} ${match.home_name} vs ${match.away_name}：列表里没找到场次号`)
        continue
      }

      try {
        await page.goto(DETAIL_URL(fid), { waitUntil: 'domcontentloaded', timeout: 45_000 })
        await page.waitForTimeout(2_000)
        const parsed = await page.evaluate(parseDetailInPage)

        if (!parsed.home && !parsed.away) {
          skipped += 1
          log(`  · ${match.match_num_str} 阵容未公布（首发 ${parsed.starterCounts.join('/') || '0'}）`)
          continue
        }

        const summary = await writeLineup({
          pool,
          sportteryMatchId: match.sporttery_match_id,
          home: parsed.home,
          away: parsed.away,
          source: '500.com',
          dryRun,
        })

        found += 1
        players += (summary?.home ?? 0) + (summary?.away ?? 0)
        log(
          `  ✓ ${match.match_num_str} ${match.home_name} vs ${match.away_name}` +
            ` 主 ${summary?.home ?? 0} 人 / 客 ${summary?.away ?? 0} 人` +
            (dryRun ? '（预演）' : ''),
        )
      } catch (error) {
        skipped += 1
        log(`  ! ${match.match_num_str} 失败: ${error.message}`)
      }
    }

    return { matched: matches.length, found, skipped, players, dryRun }
  })
}

/** 探测模式：dump 页面与网络响应，用于第一次摸结构。 */
export async function dumpLineupPage({
  url,
  outDir = '.tmp/lineup-dump',
  waitMs = 8_000,
  clickText = '',
  mobile = false,
  log = console.log,
}) {
  return withPage(
    async (page) => {
      const captured = []

      page.on('response', async (response) => {
        if (captured.length >= 120) {
          return
        }
        const type = response.headers()['content-type'] ?? ''
        if (!/json|javascript|text\/plain/i.test(type)) {
          return
        }
        try {
          const body = await response.text()
          if (!body || body.length > 400_000) {
            return
          }
          captured.push({ url: response.url(), status: response.status(), type, body })
        } catch {
          // 拿不到响应体就跳过
        }
      })

      log(`打开 ${url}`)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })

      if (clickText) {
        try {
          await page.getByText(clickText, { exact: false }).first().click({ timeout: 8_000 })
          log(`  点击「${clickText}」`)
        } catch {
          log(`  没找到可点的「${clickText}」，继续`)
        }
      }

      await page.waitForTimeout(waitMs)

      const text = await page.evaluate(() => document.body?.innerText ?? '')
      const html = await page.content()

      const candidates = []
      for (const item of captured) {
        let json = null
        try {
          json = JSON.parse(item.body)
        } catch {
          continue
        }
        const arrays = findPlayerLikeArrays(json)
        if (arrays.length > 0) {
          candidates.push({ url: item.url, arrays })
        }
      }

      const pageFile = await saveDump(outDir, 'page.txt', text.slice(0, 200_000))
      const htmlFile = await saveDump(outDir, 'page.html', html)
      await saveDump(
        outDir,
        'network.json',
        captured.map((item) => ({
          url: item.url,
          status: item.status,
          type: item.type,
          bytes: item.body.length,
        })),
      )

      log(`  DOM 文本 ${text.length} 字符 → ${pageFile}`)
      log(`  HTML → ${htmlFile}`)

      if (candidates.length > 0) {
        const candidateFile = await saveDump(outDir, 'candidates.json', candidates)
        log(`  疑似球员数组 ${candidates.length} 处 → ${candidateFile}`)
      } else {
        log('  没有在 JSON 响应里找到球员数组（阵容可能直接渲染在 HTML 里）')
      }

      return { textLength: text.length, captured: captured.length, candidates: candidates.length }
    },
    { mobile },
  )
}
