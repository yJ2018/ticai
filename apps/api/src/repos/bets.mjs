import { query, withTransaction } from '../db.mjs'
import { HttpError } from '../lib.mjs'
import { judgeLotteryBet, LOTTERY_GAMES, normalizeLotteryNumbers, resolveLotteryGame } from '../lottery-settlement.mjs'
import { computePlanMetrics, parsePassType, settleBet } from '../settlement.mjs'
import { getResultsByIds } from './results.mjs'

/**
 * 投注记录：写一份「方案快照」。
 *
 * 存的是下注当时的赔率/让球数，不跟随后的盘口变化走——否则历史注单会被改写成
 * 另一个赔率，中奖判定就失去意义。赛果不落库在 bet 里，每次读取时按 match_result 重算：
 * 开奖数据本来就只追加，实时结算不会出现「结算结果过期」。
 */

const POOLS = new Set(['had', 'hhad', 'ttg', 'crs', 'hafu'])
const MAX_LEGS = 60
const MAX_MATCHES = 15
const MAX_PASS_TYPES = 6

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value ?? null
}

function normalizeLeg(raw, index) {
  const sportteryMatchId = Number(raw?.sportteryMatchId ?? raw?.matchId)
  if (!Number.isFinite(sportteryMatchId) || sportteryMatchId <= 0) {
    throw new HttpError(400, `第 ${index + 1} 场缺少 matchId`)
  }

  const pool = String(raw?.pool ?? '').toLowerCase()
  if (!POOLS.has(pool)) {
    throw new HttpError(400, `第 ${index + 1} 场玩法不合法：${raw?.pool ?? ''}`)
  }

  const optionKey = String(raw?.optionKey ?? '').trim().slice(0, 24)
  if (!optionKey) {
    throw new HttpError(400, `第 ${index + 1} 场缺少选项`)
  }

  const odds = Number(raw?.odds)
  if (!Number.isFinite(odds) || odds < 1 || odds > 1000) {
    throw new HttpError(400, `第 ${index + 1} 场赔率不合法`)
  }

  const kickoff = raw?.kickoffAt ? new Date(raw.kickoffAt) : null

  return {
    sportteryMatchId,
    matchNumStr: raw?.matchNumStr ? String(raw.matchNumStr).slice(0, 32) : null,
    leagueName: raw?.leagueName ? String(raw.leagueName).slice(0, 64) : null,
    homeName: raw?.homeName ? String(raw.homeName).slice(0, 64) : null,
    awayName: raw?.awayName ? String(raw.awayName).slice(0, 64) : null,
    kickoffAt: kickoff && !Number.isNaN(kickoff.getTime()) ? kickoff.toISOString() : null,
    pool,
    optionKey,
    optionLabel: raw?.optionLabel ? String(raw.optionLabel).slice(0, 32) : null,
    odds: Number(odds.toFixed(2)),
    goalLine: Number.isFinite(Number(raw?.goalLine)) ? Math.trunc(Number(raw.goalLine)) : null,
  }
}

function groupLegs(legs) {
  const byMatch = new Map()
  for (const leg of legs) {
    if (!byMatch.has(leg.sportteryMatchId)) {
      byMatch.set(leg.sportteryMatchId, [])
    }
    byMatch.get(leg.sportteryMatchId).push(leg)
  }
  return Array.from(byMatch.entries()).map(([matchId, groupLegs]) => ({
    matchId,
    optionCount: groupLegs.length,
    maxOdds: groupLegs.reduce((max, leg) => Math.max(max, Number(leg.odds) || 0), 0),
  }))
}

/** 校验 body 并算出注数/金额/最高奖金；客户端传什么都不信。 */
export function buildBetPlan(body) {
  const rawLegs = Array.isArray(body?.legs) ? body.legs : []
  if (rawLegs.length === 0) {
    throw new HttpError(400, '至少选择一场比赛')
  }
  if (rawLegs.length > MAX_LEGS) {
    throw new HttpError(400, `一次最多保存 ${MAX_LEGS} 个选项`)
  }

  const legs = rawLegs.map(normalizeLeg)
  const groups = groupLegs(legs)
  if (groups.length > MAX_MATCHES) {
    throw new HttpError(400, `一次最多 ${MAX_MATCHES} 场比赛`)
  }

  const rawPassTypes = Array.isArray(body?.passTypes) ? body.passTypes : []
  const passTypes = Array.from(new Set(rawPassTypes.map((item) => String(item).trim()))).filter(Boolean)
  if (passTypes.length === 0) {
    throw new HttpError(400, '请选择过关方式')
  }
  if (passTypes.length > MAX_PASS_TYPES) {
    throw new HttpError(400, '过关方式过多')
  }

  for (const passType of passTypes) {
    const need = parsePassType(passType)
    if (need < 2) {
      throw new HttpError(400, `不支持的过关方式：${passType}`)
    }
    if (need > groups.length) {
      throw new HttpError(400, `${passType} 需要 ${need} 场，当前只选了 ${groups.length} 场`)
    }
  }

  const multiple = Number(body?.multiple)
  if (!Number.isInteger(multiple) || multiple < 1 || multiple > 50) {
    throw new HttpError(400, '倍数必须是 1–50 的整数')
  }

  const metrics = computePlanMetrics({ groups, passTypes, multiple })
  if (metrics.units <= 0) {
    throw new HttpError(400, '注数计算异常')
  }

  const title =
    String(body?.title ?? '').trim().slice(0, 64) ||
    `${groups.length}场 · ${passTypes.join('、')}`

  return {
    title,
    passTypes,
    multiple,
    units: metrics.units,
    amount: metrics.amount,
    maxBonus: metrics.maxBonus,
    note: body?.note ? String(body.note).slice(0, 200) : null,
    legs,
  }
}

export async function createBet(config, userId, body) {
  if (String(body?.kind ?? '').toLowerCase() === 'lottery') {
    return createLotteryBet(config, userId, body)
  }

  const plan = buildBetPlan(body)

  const betId = await withTransaction(config, async (client) => {
    const { rows } = await client.query(
      `insert into bet (user_id, title, pass_types, multiple, units, amount, max_bonus, note)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id`,
      [userId, plan.title, plan.passTypes, plan.multiple, plan.units, plan.amount, plan.maxBonus, plan.note],
    )
    const id = rows[0].id

    for (const leg of plan.legs) {
      await client.query(
        `insert into bet_leg (
           bet_id, sporttery_match_id, match_num_str, league_name, home_name, away_name, kickoff_at,
           pool, option_key, option_label, odds, goal_line
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          leg.sportteryMatchId,
          leg.matchNumStr,
          leg.leagueName,
          leg.homeName,
          leg.awayName,
          leg.kickoffAt,
          leg.pool,
          leg.optionKey,
          leg.optionLabel,
          leg.odds,
          leg.goalLine,
        ],
      )
    }

    return id
  })

  return getBet(config, userId, betId)
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 彩票注单：号码 + 倍数，校验全部在服务端做（前端选号器只是输入辅助）。 */
export function buildLotteryBet(body) {
  const game = resolveLotteryGame(body?.game ?? body?.gameNo)
  if (!game) {
    throw new HttpError(400, '不支持的彩种（排列五 / 七星彩 / 大乐透）')
  }

  const numbers = normalizeLotteryNumbers(game.key, body?.numbers)

  const multiple = Number(body?.multiple ?? 1)
  if (!Number.isInteger(multiple) || multiple < 1 || multiple > 50) {
    throw new HttpError(400, '倍数必须是 1–50 的整数')
  }

  const numberText = game.extraCount
    ? `${numbers.main.map(pad2).join(' ')} + ${numbers.extra.map(pad2).join(' ')}`
    : numbers.main.join(' ')
  const title = `${game.name} ${numberText}`.slice(0, 64)

  return {
    game,
    numbers,
    multiple,
    units: multiple,
    amount: Number((2 * multiple).toFixed(2)),
    title,
    note: body?.note ? String(body.note).slice(0, 200) : null,
  }
}

export async function createLotteryBet(config, userId, body) {
  const plan = buildLotteryBet(body)

  const { rows } = await query(
    config,
    `insert into bet (
       user_id, kind, title, pass_types, multiple, units, amount, max_bonus, note,
       lottery_game_no, lottery_numbers
     ) values ($1, 'lottery', $2, '{}', $3, $4, $5, 0, $6, $7, $8::jsonb)
     returning id`,
    [
      userId,
      plan.title,
      plan.multiple,
      plan.units,
      plan.amount,
      plan.note,
      plan.game.gameNo,
      JSON.stringify(plan.numbers),
    ],
  )

  return getBet(config, userId, rows[0].id)
}

async function loadLegs(config, betIds) {
  if (betIds.length === 0) {
    return []
  }
  const { rows } = await query(
    config,
    `select id, bet_id, sporttery_match_id, match_num_str, league_name, home_name, away_name,
            kickoff_at, pool, option_key, option_label, odds, goal_line
     from bet_leg
     where bet_id = any($1::bigint[])
     order by kickoff_at nulls last, id`,
    [betIds],
  )
  return rows
}

function toLegShape(row) {
  return {
    id: String(row.id),
    betId: String(row.bet_id),
    sportteryMatchId: Number(row.sporttery_match_id),
    matchNo: row.match_num_str ?? '',
    leagueName: row.league_name ?? '',
    homeName: row.home_name ?? '',
    awayName: row.away_name ?? '',
    kickoffAt: toIso(row.kickoff_at),
    pool: row.pool,
    optionKey: row.option_key,
    optionLabel: row.option_label ?? row.option_key,
    odds: Number(row.odds),
    goalLine: row.goal_line === null ? null : Number(row.goal_line),
  }
}

async function loadNextDraw(config, gameNo, placedAt) {
  const { rows } = await query(
    config,
    `select issue, draw_date, main_numbers, extra_numbers
     from lottery_draw
     where game_no = $1
       and coalesce(draw_at, draw_date::timestamptz + interval '21 hours') > $2::timestamptz
     order by coalesce(draw_at, draw_date::timestamptz + interval '21 hours') asc
     limit 1`,
    [gameNo, placedAt],
  )
  return rows[0] ?? null
}

function gameByNo(gameNo) {
  return Object.values(LOTTERY_GAMES).find((game) => game.gameNo === gameNo) ?? null
}

async function hydrate(config, betRows, legsByBet) {
  // 注意：pg 把 bigint 读成字符串，Map 的 key 必须统一成 String，
  // 否则 create/get 时按 number 取不到腿，结算会误判成「未中奖」。
  const allLegs = betRows.flatMap((row) => legsByBet.get(String(row.id)) ?? [])
  const resultMap = await getResultsByIds(config, allLegs.map((leg) => leg.sporttery_match_id))

  const lotteryByBet = new Map()
  for (const row of betRows) {
    if (row.kind !== 'lottery') {
      continue
    }
    const game = gameByNo(row.lottery_game_no)
    if (!game) {
      continue
    }
    const draw = await loadNextDraw(config, row.lottery_game_no, row.placed_at)
    const numbers = row.lottery_numbers ?? { main: [], extra: [] }
    const judged = judgeLotteryBet(game.key, numbers, draw)
    lotteryByBet.set(String(row.id), { game, numbers, judged })
  }

  return betRows.map((row) => {
    if (row.kind === 'lottery') {
      const info = lotteryByBet.get(String(row.id))
      const judged = info?.judged ?? { status: 'pending', tier: null, hits: { main: 0, extra: 0 }, matchedMain: [], draw: null }
      return {
        id: String(row.id),
        kind: 'lottery',
        title: row.title,
        passTypes: [],
        multiple: Number(row.multiple),
        units: Number(row.units),
        amount: Number(row.amount),
        maxBonus: Number(row.max_bonus),
        note: row.note ?? null,
        placedAt: toIso(row.placed_at),
        matchCount: 0,
        status: judged.status,
        payout: 0,
        passTypeDetails: [],
        legs: [],
        lottery: {
          gameKey: info?.game.key ?? '',
          gameNo: row.lottery_game_no,
          name: info?.game.name ?? '',
          positional: info?.game.positional ?? false,
          numbers: info?.numbers ?? { main: [], extra: [] },
          tier: judged.tier,
          hits: judged.hits,
          matchedMain: judged.matchedMain,
          draw: judged.draw,
        },
      }
    }

    const legs = (legsByBet.get(String(row.id)) ?? []).map(toLegShape)
    const settlement = settleBet({
      bet: { passTypes: row.pass_types, multiple: row.multiple },
      legs,
      results: resultMap,
    })

    return {
      id: String(row.id),
      kind: 'football',
      title: row.title,
      passTypes: row.pass_types,
      multiple: Number(row.multiple),
      units: Number(row.units),
      amount: Number(row.amount),
      maxBonus: Number(row.max_bonus),
      note: row.note ?? null,
      placedAt: toIso(row.placed_at),
      matchCount: new Set(legs.map((leg) => leg.sportteryMatchId)).size,
      status: settlement.status,
      payout: settlement.payout,
      passTypeDetails: settlement.passTypeDetails,
      legs: settlement.legs.map((leg) => {
        const meta = legs.find((item) => item.id === leg.id)
        return {
          ...leg,
          matchNo: meta?.matchNo ?? '',
          leagueName: meta?.leagueName ?? '',
          homeName: meta?.homeName ?? '',
          awayName: meta?.awayName ?? '',
          kickoffAt: meta?.kickoffAt ?? null,
        }
      }),
    }
  })
}

function betWhere(pool) {
  return pool
    ? `and b.kind = 'football' and exists (select 1 from bet_leg l where l.bet_id = b.id and l.pool = $4)`
    : ''
}

export async function listBets(config, userId, { limit = 30, offset = 0, pool = '' } = {}) {
  const poolFilter = POOLS.has(pool) ? pool : ''
  const params = [userId, limit, offset]
  if (poolFilter) {
    params.push(poolFilter)
  }

  const { rows } = await query(
    config,
    `select b.id, b.kind, b.title, b.pass_types, b.multiple, b.units, b.amount, b.max_bonus, b.note, b.placed_at,
            b.lottery_game_no, b.lottery_numbers
     from bet b
     where b.user_id = $1 ${betWhere(poolFilter)}
     order by b.placed_at desc, b.id desc
     limit $2 offset $3`,
    params,
  )

  const legs = await loadLegs(config, rows.map((row) => row.id))
  const legsByBet = new Map()
  for (const leg of legs) {
    const key = String(leg.bet_id)
    if (!legsByBet.has(key)) {
      legsByBet.set(key, [])
    }
    legsByBet.get(key).push(leg)
  }

  return hydrate(config, rows, legsByBet)
}

export async function getBet(config, userId, betId) {
  const id = Number(betId)
  if (!Number.isFinite(id) || id <= 0) {
    throw new HttpError(400, '投注单 id 不合法')
  }

  const { rows } = await query(
    config,
    `select b.id, b.kind, b.title, b.pass_types, b.multiple, b.units, b.amount, b.max_bonus, b.note, b.placed_at,
            b.lottery_game_no, b.lottery_numbers
     from bet b
     where b.id = $1 and b.user_id = $2
     limit 1`,
    [id, userId],
  )
  if (rows.length === 0) {
    throw new HttpError(404, '投注单不存在')
  }

  const legs = await loadLegs(config, [id])
  const legsByBet = new Map([[String(id), legs]])
  const [bet] = await hydrate(config, rows, legsByBet)
  return bet
}

export async function deleteBet(config, userId, betId) {
  const id = Number(betId)
  if (!Number.isFinite(id) || id <= 0) {
    throw new HttpError(400, '投注单 id 不合法')
  }
  const { rowCount } = await query(config, 'delete from bet where id = $1 and user_id = $2', [id, userId])
  if ((rowCount ?? 0) === 0) {
    throw new HttpError(404, '投注单不存在')
  }
  return { ok: true }
}

/** 汇总：给「我的投注」顶部统计用。 */
export async function getBetStats(config, userId) {
  const { rows } = await query(
    config,
    `select b.id, b.kind, b.pass_types, b.multiple, b.amount, b.placed_at,
            b.lottery_game_no, b.lottery_numbers
     from bet b where b.user_id = $1 order by b.placed_at desc limit 200`,
    [userId],
  )

  const legs = await loadLegs(config, rows.map((row) => row.id))
  const legsByBet = new Map()
  for (const leg of legs) {
    const key = String(leg.bet_id)
    if (!legsByBet.has(key)) {
      legsByBet.set(key, [])
    }
    legsByBet.get(key).push(leg)
  }

  const hydrated = await hydrate(config, rows, legsByBet)
  const stats = { total: hydrated.length, pending: 0, won: 0, lost: 0, amount: 0, payout: 0 }
  for (const bet of hydrated) {
    stats[bet.status] = (stats[bet.status] ?? 0) + 1
    stats.amount += bet.amount
    stats.payout += bet.payout
  }
  stats.amount = Number(stats.amount.toFixed(2))
  stats.payout = Number(stats.payout.toFixed(2))
  return stats
}
