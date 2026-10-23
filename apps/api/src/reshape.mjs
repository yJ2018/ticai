/**
 * 纯函数：数据库行 → 旧接口响应形状。
 *
 * 这里是整个迁移的关键——前端 matchService / historyService 解析的是体彩原始
 * 结构，所以只要新接口继续吐同样的形状，前端一行都不用改。
 * 不碰数据库、不碰 req/res，可以直接单测。
 */

/** pg 的 bigint / numeric 默认返回字符串；前端需要 number 的地方在这里转。 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return undefined
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** numeric 保留字符串（金额可能有小数），但去掉无意义的 .00。 */
function toAmount(value) {
  if (value === null || value === undefined || value === '') {
    return undefined
  }
  const text = String(value)
  return text.endsWith('.00') ? text.slice(0, -3) : text
}

function compact(object) {
  const result = {}
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  return result
}

/**
 * 赛事行 → 体彩 getMatchCalculatorV1 的信封。
 *
 * @param {Array<{
 *   sporttery_match_id: string|number,
 *   business_date: string,
 *   match_num_str: string|null,
 *   match_time: string,
 *   league_name: string,
 *   home_team_sporttery_id: string|number|null,
 *   away_team_sporttery_id: string|number|null,
 *   home_name: string,
 *   away_name: string,
 *   odds: object|null
 * }>} rows 已按 business_date, kickoff_at 升序
 */
export function toMatchEnvelope(rows) {
  const groups = new Map()

  for (const row of rows) {
    const businessDate = row.business_date ?? ''
    const odds = row.odds && typeof row.odds === 'object' ? row.odds : {}

    const item = compact({
      matchId: toNumber(row.sporttery_match_id),
      matchNumStr: row.match_num_str ?? undefined,
      leagueAllName: row.league_name ?? undefined,
      homeTeamAbbName: row.home_name ?? undefined,
      awayTeamAbbName: row.away_name ?? undefined,
      homeTeamId: toNumber(row.home_team_sporttery_id),
      awayTeamId: toNumber(row.away_team_sporttery_id),
      // 真实比赛日：和 businessDate（销售日）不同，凌晨场次会差一天
      matchDate: row.match_date ?? undefined,
      matchTime: row.match_time ?? undefined,
      // 五个玩法原样透传，前端按 poolType 自己取
      had: odds.had,
      hhad: odds.hhad,
      ttg: odds.ttg,
      crs: odds.crs,
      hafu: odds.hafu,
    })

    if (!groups.has(businessDate)) {
      groups.set(businessDate, [])
    }
    groups.get(businessDate).push(item)
  }

  return {
    success: true,
    errorCode: '0',
    errorMessage: '',
    value: {
      matchInfoList: Array.from(groups, ([businessDate, subMatchList]) => ({
        businessDate,
        subMatchList,
      })),
    },
  }
}

/**
 * 开奖行 + 奖级行 → 体彩 getHistoryPageListV1 的信封。
 *
 * 注意：同时输出上游真名（totalSaleAmount / poolBalance）和历史误用名
 * （lotterySaleAmount / poolAmount）。前端现在读的是后者，这样不用改前端
 * 也能把"销售额/奖池"显示出来。
 */
export function toHistoryEnvelope({ draws, levels, pageNo, pageSize, total, gameName }) {
  const levelsByDraw = new Map()
  for (const level of levels) {
    const key = String(level.draw_id)
    if (!levelsByDraw.has(key)) {
      levelsByDraw.set(key, [])
    }
    levelsByDraw.get(key).push({
      prizeLevel: level.prize_key,
      prizeLevelName: level.prize_key,
      stakeCount: level.stake_count ?? undefined,
      prizeAmount: toAmount(level.prize_amount),
      totalPrizeamount: toAmount(level.total_amount),
      sort: level.sort_no ?? undefined,
    })
  }

  const list = draws.map((draw) => {
    const drawLevels = levelsByDraw.get(String(draw.id)) ?? []
    drawLevels.sort((left, right) => (left.sort ?? 0) - (right.sort ?? 0))

    const sales = toAmount(draw.sales_amount)
    const pool = toAmount(draw.pool_balance)

    return compact({
      lotteryGameName: gameName ?? undefined,
      lotteryDrawNum: draw.issue,
      lotteryDrawTime: draw.draw_date,
      lotteryDrawResult: draw.numbers_text,
      lotteryUnsortDrawresult: draw.numbers_text,
      // 上游真名
      totalSaleAmount: sales,
      poolBalance: pool,
      // 兼容历史前端字段
      lotterySaleAmount: sales,
      poolAmount: pool,
      prizeLevelList: drawLevels.length > 0 ? drawLevels : undefined,
    })
  })

  const safeTotal = Number.isFinite(Number(total)) ? Number(total) : list.length
  const safeSize = Number(pageSize) > 0 ? Number(pageSize) : 30

  return {
    success: true,
    errorCode: '0',
    errorMessage: '',
    value: {
      list,
      pageNo: Number(pageNo) > 0 ? Number(pageNo) : 1,
      pageSize: safeSize,
      total: safeTotal,
      pages: safeTotal > 0 ? Math.ceil(safeTotal / safeSize) : 1,
    },
  }
}
