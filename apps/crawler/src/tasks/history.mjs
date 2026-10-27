import { refreshSnapshots } from '../../../api/src/analysis/compute.mjs'
import { finishRun, loadGames, startRun, withTransaction } from '../db.mjs'
import { sleep } from '../http.mjs'
import { normalizeDraw } from '../normalize.mjs'
import { fetchHistoryPage } from '../sporttery.mjs'

/**
 * 开奖抓取。默认只抓最新一页；--backfill 时逐页回灌历史。
 *
 * 每个彩种一条 crawl_run（source = sporttery.history:pl5），
 * 这样 /api/health 能分别显示四个彩种的新鲜度。
 *
 * 写完开奖后立刻重算分析快照（见 refreshAnalysis）：分析要全量样本，
 * 放在浏览器里算要先翻 78 页（约 140s），而且结果只在多了一期时才变——
 * 所以「开奖入库 → 算一次 → 存快照」是这套算法唯一合理的触发点。
 *
 * 写库按「页」批量：一页 100 期一条多值 insert + 一条奖级 insert。
 * 跨境库每次 round trip 都在 0.5s 上下，逐条 upsert 会让一页从 1s 变成 80s。
 */

const INSERT_PRIZES = `
  insert into lottery_prize_level
    (draw_id, prize_key, sort_no, stake_count, prize_amount, total_amount)
  select * from unnest($1::bigint[], $2::text[], $3::int[], $4::bigint[], $5::numeric[], $6::numeric[])
  on conflict (draw_id, prize_key) do update set
    sort_no      = excluded.sort_no,
    stake_count  = excluded.stake_count,
    prize_amount = excluded.prize_amount,
    total_amount = excluded.total_amount
`

const DRAW_COLUMNS = [
  'game_no',
  'issue',
  'issue_seq',
  'draw_date',
  'main_numbers',
  'extra_numbers',
  'numbers_text',
  'sales_amount',
  'pool_balance',
  'pool_balance_after',
  'raw',
]

async function savePage(pool, game, list, log) {
  let skipped = 0
  const rows = []

  for (const item of list) {
    try {
      rows.push(normalizeDraw(item, game))
    } catch (error) {
      skipped += 1
      log(`  ! ${game.name} 跳过异常开奖 ${item?.lotteryDrawNum ?? '?'}: ${error.message}`)
    }
  }

  if (rows.length === 0) {
    return { saved: 0, skipped }
  }

  await withTransaction(pool, async (client) => {
    // 跨境写库：一行一次 round trip 太慢（100 期要 80s），改成一页一条多值 insert
    const placeholders = rows
      .map((_, rowIndex) => {
        const base = rowIndex * DRAW_COLUMNS.length
        const values = DRAW_COLUMNS.map((__, columnIndex) => `$${base + columnIndex + 1}`)
        return `(${values.join(', ')})`
      })
      .join(', ')

    const params = rows.flatMap((row) => [
      row.gameNo,
      row.issue,
      row.issueSeq,
      row.drawDate,
      row.mainNumbers,
      row.extraNumbers,
      row.numbersText,
      row.salesAmount,
      row.poolBalance,
      row.poolBalanceAfter,
      JSON.stringify(row.raw ?? {}),
    ])

    const { rows: inserted } = await client.query(
      `insert into lottery_draw (${DRAW_COLUMNS.join(', ')})
       values ${placeholders}
       on conflict (game_no, issue) do update set
         issue_seq          = excluded.issue_seq,
         draw_date          = excluded.draw_date,
         main_numbers       = excluded.main_numbers,
         extra_numbers      = excluded.extra_numbers,
         numbers_text       = excluded.numbers_text,
         sales_amount       = excluded.sales_amount,
         pool_balance       = excluded.pool_balance,
         pool_balance_after = excluded.pool_balance_after,
         raw                = excluded.raw,
         updated_at         = now()
       returning id, issue`,
      params,
    )

    const idByIssue = new Map(inserted.map((row) => [row.issue, row.id]))
    const drawIds = []
    const prizeRows = []

    for (const row of rows) {
      const drawId = idByIssue.get(row.issue)
      if (!drawId) {
        continue
      }
      drawIds.push(drawId)
      for (const prize of row.prizes) {
        prizeRows.push({ drawId, ...prize })
      }
    }

    if (drawIds.length === 0) {
      return
    }

    // 奖级整体替换：上游删掉一个奖级时，delete+insert 比逐条 upsert 更不容易残留
    await client.query('delete from lottery_prize_level where draw_id = any($1::bigint[])', [drawIds])

    if (prizeRows.length > 0) {
      await client.query(INSERT_PRIZES, [
        prizeRows.map((row) => row.drawId),
        prizeRows.map((row) => row.prizeKey),
        prizeRows.map((row) => row.sortNo),
        prizeRows.map((row) => row.stakeCount),
        prizeRows.map((row) => row.prizeAmount),
        prizeRows.map((row) => row.totalAmount),
      ])
    }
  })

  return { saved: rows.length, skipped }
}

/**
 * 开奖入库后触发分析快照重算。
 *
 * 失败只告警：分析是「锦上添花」，不能因为算不出来就把一次成功的抓取标成失败；
 * 下一次抓取或 npm run analyze:snapshot 会补上。
 *
 * 导出是为了让爬虫测试能在不联网的情况下钉住这条契约。
 */
export async function refreshAnalysis({ pool, game, saved, runId, log }) {
  if (saved === 0) {
    return { computed: 0, skipped: 0 }
  }

  const startedAt = Date.now()
  try {
    const result = await refreshSnapshots({
      runQuery: (text, params) => pool.query(text, params),
      gameKey: game.gameKey,
      source: 'crawler',
      crawlRunId: runId,
      log,
    })
    const computed = result.results.filter((item) => item.status === 'computed').length
    const skipped = result.results.filter((item) => item.status === 'skipped').length
    const elapsed = Date.now() - startedAt
    log(
      `  ${game.gameKey} 分析快照：重算 ${computed} 条 · 已最新 ${skipped} 条 · ${elapsed}ms` +
        (result.latest ? ` · 基准 ${result.latest.issue}（${result.latest.drawDate}）` : ''),
    )
    return { computed, skipped }
  } catch (error) {
    log(`  ! ${game.gameKey} 分析快照失败：${error.message}（不影响开奖入库）`)
    return { computed: 0, skipped: 0, error: error.message }
  }
}

export async function crawlHistory({
  pool,
  config,
  backfill = false,
  maxPages,
  delayMs,
  jitterMs,
  gameKeys,
  log = console.log,
}) {
  const allGames = await loadGames(pool, config.gameNos)
  if (allGames.length === 0) {
    throw new Error('lottery_game 里没有启用的彩种，请先执行 npm run db:seed')
  }

  const games =
    Array.isArray(gameKeys) && gameKeys.length > 0
      ? allGames.filter((game) => gameKeys.includes(game.gameKey))
      : allGames
  if (games.length === 0) {
    throw new Error(`CRAWL_GAMES 里没有这些彩种：${gameKeys.join(', ')}`)
  }

  const pageLimit = Math.min(maxPages ?? config.maxPages, config.maxPages)
  // 回灌是长跑，按页限速：base + 0~jitter 的随机间隔，别让请求节奏像机器
  const pageDelay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : config.delayMs
  const pageJitter = Number.isFinite(jitterMs) ? Math.max(0, jitterMs) : Math.round(pageDelay * 0.5)
  const summary = []

  for (const game of games) {
    const runId = await startRun(pool, {
      source: `sporttery.history:${game.gameKey}`,
      meta: { gameNo: game.gameNo, backfill },
    })

    let saved = 0
    let skipped = 0
    let pages = 1
    let page = 1

    try {
      do {
        const result = await fetchHistoryPage(config, {
          gameNo: game.gameNo,
          pageNo: page,
          pageSize: config.historyPageSize,
        })

        pages = Math.max(1, Math.min(result.pages, pageLimit))

        const pageResult = await savePage(pool, game, result.list, log)
        saved += pageResult.saved
        skipped += pageResult.skipped

        if (backfill) {
          log(
            `  ${game.gameKey} ${page}/${pages} 页 · 写入 ${pageResult.saved} 期` +
              (pageResult.skipped > 0 ? ` · 跳过 ${pageResult.skipped}` : ''),
          )
        }

        if (!backfill) {
          break
        }

        page += 1
        if (page <= pages) {
          await sleep(pageDelay + Math.floor(Math.random() * pageJitter))
        }
      } while (page <= pages)

      await finishRun(pool, runId, {
        status: 'ok',
        itemCount: saved,
        changedCount: saved,
      })

      // 开奖入完库再算分析：没有新一期时 refreshSnapshots 只查一行、不重算
      const analysis = await refreshAnalysis({ pool, game, saved, runId, log })

      summary.push({
        game: game.gameKey,
        saved,
        skipped,
        pages: backfill ? pages : 1,
        analysisComputed: analysis.computed,
        analysisSkipped: analysis.skipped,
      })
    } catch (error) {
      await finishRun(pool, runId, { status: 'failed', error: error.message })
      summary.push({ game: game.gameKey, saved, skipped, error: error.message })
    }

    if (games.indexOf(game) < games.length - 1) {
      await sleep(pageDelay)
    }
  }

  return summary
}
