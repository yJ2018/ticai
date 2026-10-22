import { finishRun, loadGames, startRun, withTransaction } from '../db.mjs'
import { sleep } from '../http.mjs'
import { normalizeDraw } from '../normalize.mjs'
import { fetchHistoryPage } from '../sporttery.mjs'

/**
 * 开奖抓取。默认只抓最新一页；--backfill 时逐页回灌历史。
 *
 * 每个彩种一条 crawl_run（source = sporttery.history:pl5），
 * 这样 /api/health 能分别显示四个彩种的新鲜度。
 */

const UPSERT_DRAW = `
  insert into lottery_draw
    (game_no, issue, issue_seq, draw_date, main_numbers, extra_numbers, numbers_text,
     sales_amount, pool_balance, pool_balance_after, raw)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
  returning id
`

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

async function savePage(pool, game, list, log) {
  let saved = 0
  let skipped = 0

  await withTransaction(pool, async (client) => {
    const drawIds = []
    const prizeRows = []

    for (const item of list) {
      let row
      try {
        row = normalizeDraw(item, game)
      } catch (error) {
        skipped += 1
        log(`  ! ${game.name} 跳过异常开奖 ${item?.lotteryDrawNum ?? '?'}: ${error.message}`)
        continue
      }

      const { rows } = await client.query(UPSERT_DRAW, [
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
        row.raw,
      ])

      const drawId = rows[0].id
      drawIds.push(drawId)
      saved += 1

      for (const prize of row.prizes) {
        prizeRows.push({ drawId, ...prize })
      }
    }

    if (drawIds.length > 0) {
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
    }
  })

  return { saved, skipped }
}

export async function crawlHistory({ pool, config, backfill = false, maxPages, log = console.log }) {
  const games = await loadGames(pool, config.gameNos)
  if (games.length === 0) {
    throw new Error('lottery_game 里没有启用的彩种，请先执行 npm run db:seed')
  }

  const pageLimit = Math.min(maxPages ?? config.maxPages, config.maxPages)
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

        if (!backfill) {
          break
        }

        page += 1
        if (page <= pages) {
          await sleep(config.delayMs)
        }
      } while (page <= pages)

      await finishRun(pool, runId, {
        status: 'ok',
        itemCount: saved,
        changedCount: saved,
      })

      summary.push({ game: game.gameKey, saved, skipped, pages: backfill ? pages : 1 })
    } catch (error) {
      await finishRun(pool, runId, { status: 'failed', error: error.message })
      summary.push({ game: game.gameKey, saved, skipped, error: error.message })
    }

    if (games.indexOf(game) < games.length - 1) {
      await sleep(config.delayMs)
    }
  }

  return summary
}
