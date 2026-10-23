import { createHash } from 'node:crypto'

/**
 * 纯函数：上游 JSON → 数据库行。
 *
 * 不碰网络、不碰数据库，全部可单测。爬虫最容易出错的不是请求，
 * 而是"日期少 8 小时""号码拆错位""金额少了小数"这类转换，所以这里单独拆出来。
 */

const NUMERIC_POOLS = ['had', 'hhad', 'ttg', 'crs', 'hafu']

/**
 * 真正的开赛日期。
 *
 * 赛程接口按「销售日」分组（businessDate），跨零点的场次归在前一天的期号里，
 * 元素自带的 matchDate 才是实际的比赛日。只用 businessDate + matchTime 拼时间，
 * 所有凌晨场次都会整体提前 24 小时——开赛前一天就被判成已停售，阵容随之消失。
 * 只有上游没给 matchDate 时才退回 businessDate。
 */
export function resolveMatchDate(item, businessDate) {
  const fallback = String(businessDate ?? '').trim().slice(0, 10)
  const fromItem = String(item?.matchDate ?? '').trim().slice(0, 10)

  if (!isDateOnly(fromItem)) {
    return fallback
  }
  // 开赛日不会早于销售日：比销售日还早的一律当脏数据
  if (isDateOnly(fallback) && fromItem < fallback) {
    return fallback
  }
  return fromItem
}

/** 'YYYY-MM-DD' 且是真实存在的日期；'0000-00-00'、'2026-02-30' 都算脏数据。 */
function isDateOnly(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false
  }
  const stamp = Date.parse(`${text}T00:00:00+08:00`)
  if (!Number.isFinite(stamp)) {
    return false
  }
  // 加回 8 小时再取 UTC 日期，等于「这一天在北京时间下的日期」
  return new Date(stamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) === text
}

/** 体彩的日期和时刻是分开给的，且都是北京时间；不补 +08:00 会整体差 8 小时。 */
export function parseKickoff(businessDate, matchTime) {
  const date = String(businessDate ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`businessDate 非法：${businessDate}`)
  }

  const rawTime = String(matchTime ?? '').trim()
  const time = /^\d{2}:\d{2}:\d{2}$/.test(rawTime)
    ? rawTime
    : /^\d{2}:\d{2}$/.test(rawTime)
      ? `${rawTime}:00`
      : '00:00:00'

  const iso = `${date}T${time}+08:00`
  if (Number.isNaN(new Date(iso).getTime())) {
    throw new Error(`开赛时间非法：${date} ${time}`)
  }
  return iso
}

/**
 * 稳定序列化：键排序后输出，保证同样的赔率内容永远得到同一个 hash。
 * 同时剔除 updateDate / updateTime —— 它们每次刷新都变，但不代表赔率真的变了，
 * 留着会让快照表按刷新频率膨胀。
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }

  const keys = Object.keys(value)
    .filter((key) => key !== 'updateDate' && key !== 'updateTime')
    .sort()

  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

export function hashOdds(odds) {
  return createHash('sha256').update(stableStringify(odds)).digest('hex')
}

/** "314,954,142" → "314954142"；保留小数，去掉千分位。 */
export function parseMoney(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const text = String(value).replace(/,/g, '').trim()
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    return null
  }
  return text
}

/**
 * 号码拆分。
 * 大乐透是 "01 06 10 15 32 03 04"（前 5 + 后 2），
 * 排列三/五、七星彩是单位数字空格分隔，没有后区。
 */
export function parseNumbers(text, { mainCount, extraCount = 0 } = {}) {
  const raw = String(text ?? '').trim()
  if (!raw) {
    throw new Error('开奖号码为空')
  }

  let tokens = raw.split(/\s+/).filter(Boolean)
  const expected = Number(mainCount ?? 0) + Number(extraCount ?? 0)

  // 兜底：没有空格且长度正好，按位拆（历史接口偶尔这么给）
  if (tokens.length === 1 && expected > 0 && tokens[0].length === expected) {
    tokens = tokens[0].split('')
  }

  const numbers = tokens.map((token) => Number(token))
  if (numbers.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error(`开奖号码非法：${raw}`)
  }
  if (expected > 0 && numbers.length !== expected) {
    throw new Error(`开奖号码位数不符：期望 ${expected}，实际 ${numbers.length}（${raw}）`)
  }

  if (extraCount > 0) {
    return {
      main: numbers.slice(0, mainCount),
      extra: numbers.slice(mainCount),
    }
  }

  return { main: numbers, extra: [] }
}

/** 赛程接口的一个 subMatchList 元素 → 可入库的行。 */
export function normalizeMatch(item, businessDate) {
  const odds = {}
  for (const pool of NUMERIC_POOLS) {
    if (item?.[pool] && typeof item[pool] === 'object' && Object.keys(item[pool]).length > 0) {
      odds[pool] = item[pool]
    }
  }

  const homeName = item?.homeTeamAbbName ?? '主队'
  const awayName = item?.awayTeamAbbName ?? '客队'

  return {
    sportteryMatchId: Number(item?.matchId),
    businessDate: String(businessDate ?? '').slice(0, 10),
    matchNumStr: item?.matchNumStr ?? null,
    kickoffAt: parseKickoff(resolveMatchDate(item, businessDate), item?.matchTime),
    leagueName: item?.leagueAllName ?? '未知联赛',
    homeTeamId: Number.isFinite(Number(item?.homeTeamId)) ? Number(item.homeTeamId) : null,
    awayTeamId: Number.isFinite(Number(item?.awayTeamId)) ? Number(item.awayTeamId) : null,
    homeName,
    awayName,
    odds,
    oddsHash: hashOdds(odds),
    raw: item,
  }
}

/** 开奖列表的一条 → 可入库的行（含奖级）。 */export function normalizeDraw(item, game) {
  const issue = String(item?.lotteryDrawNum ?? '').trim()
  if (!/^\d+$/.test(issue)) {
    throw new Error(`期号非法：${item?.lotteryDrawNum}`)
  }

  const { main, extra } = parseNumbers(item?.lotteryDrawResult ?? item?.lotteryUnsortDrawresult, {
    mainCount: game.mainCount,
    extraCount: game.extraCount,
  })

  const prizes = (Array.isArray(item?.prizeLevelList) ? item.prizeLevelList : [])
    .filter((level) => level && typeof level === 'object')
    .map((level) => ({
      prizeKey: String(level.prizeLevel ?? level.group ?? '未知奖级'),
      sortNo: Number.isFinite(Number(level.sort)) ? Number(level.sort) : null,
      stakeCount: parseMoney(level.stakeCount),
      prizeAmount: parseMoney(level.stakeAmountFormat ?? level.stakeAmount),
      totalAmount: parseMoney(level.totalPrizeamount ?? level.totalAmount),
      raw: level,
    }))

  const drawDate = String(item?.lotteryDrawTime ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(drawDate)) {
    throw new Error(`开奖日期非法：${item?.lotteryDrawTime}（期号 ${issue}）`)
  }

  return {
    gameNo: game.gameNo,
    issue,
    issueSeq: Number(issue),
    drawDate,
    mainNumbers: main,
    extraNumbers: extra,
    numbersText: String(item?.lotteryDrawResult ?? '').trim(),
    salesAmount: parseMoney(item?.totalSaleAmount),
    poolBalance: parseMoney(item?.poolBalance),
    poolBalanceAfter: parseMoney(item?.poolBalanceAfterdraw),
    raw: item,
    prizes,
  }
}

// ============================================================================
// 对战数据（m.sporttery.cn/zqlszl/bssj 背后的接口）
// ============================================================================

/** "2:5" → { home: 2, away: 5 }；空串或异常返回 null。 */
export function parseGoalPair(value) {
  const text = String(value ?? '').trim()
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(text)
  if (!match) {
    return null
  }
  return { home: Number(match[1]), away: Number(match[2]) }
}

/**
 * 近期赛果：主客两侧各一串 matchList，同一场比赛可能出现两次，按
 * sportteryMatchId 去重。fullCourtGoal / halfTimeGoal 就是全场与半场比分。
 */
export function parseResultEntries(value) {
  const byId = new Map()

  for (const side of ['home', 'away']) {
    const list = value?.[side]?.matchList
    if (!Array.isArray(list)) {
      continue
    }

    for (const item of list) {
      const id = Number(item?.sportteryMatchId)
      if (!Number.isFinite(id) || id <= 0) {
        continue
      }

      const full = parseGoalPair(item.fullCourtGoal)
      if (!full) {
        continue
      }
      const half = parseGoalPair(item.halfTimeGoal)
      const next = {
        sportteryMatchId: id,
        matchDate: /^\d{4}-\d{2}-\d{2}/.test(String(item.matchDate ?? ''))
          ? String(item.matchDate).slice(0, 10)
          : null,
        homeScore: full.home,
        awayScore: full.away,
        homeHalfScore: half ? half.home : null,
        awayHalfScore: half ? half.away : null,
        homeName: item.homeTeamShortName ?? '',
        awayName: item.awayTeamShortName ?? '',
        tournament: item.tournamentShortName ?? '',
        raw: item,
      }

      // 同一场比赛会同时出现在主队和客队的列表里，后到的那份可能更稀疏，
      // 所以按字段合并而不是直接覆盖。
      const previous = byId.get(id)
      byId.set(
        id,
        previous
          ? {
              ...next,
              matchDate: next.matchDate ?? previous.matchDate,
              homeHalfScore: next.homeHalfScore ?? previous.homeHalfScore,
              awayHalfScore: next.awayHalfScore ?? previous.awayHalfScore,
              homeName: next.homeName || previous.homeName,
              awayName: next.awayName || previous.awayName,
              tournament: next.tournament || previous.tournament,
            }
          : next,
      )
    }
  }

  return Array.from(byId.values())
}

/**
 * 伤停名单：每侧一个 block，带 sportteryTeamId，可以映射回 team 表。
 * 注意这是"本场不可用球员"，不是全队名单——不能拿它反推阵容。
 */
export function parseInjuryEntries(value) {
  const entries = []

  for (const side of ['home', 'away']) {
    const block = value?.[side]
    if (!block || typeof block !== 'object') {
      continue
    }

    const teamSportteryId = Number(block.sportteryTeamId)
    const list = block.injuriesAndSuspensionsList

    for (const person of Array.isArray(list) ? list : []) {
      const personId = Number(person?.personId)
      if (!Number.isFinite(personId) || personId <= 0) {
        continue
      }

      entries.push({
        side,
        teamSportteryId: Number.isFinite(teamSportteryId) ? teamSportteryId : null,
        personId,
        name: String(person.personName ?? '').trim() || `球员${personId}`,
        position: person.playerPositionDesc ?? person.playerPositionCode ?? null,
        uniformNo: Number.isFinite(Number(person.uniformNo)) ? Number(person.uniformNo) : null,
        kind: Number(person.suspensionFlag) === 1 ? 'suspension' : 'injury',
        appearanceCnt: Number(person.appearanceCnt) || 0,
        raw: person,
      })
    }
  }

  return entries
}
