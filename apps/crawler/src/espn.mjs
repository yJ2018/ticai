/**
 * ESPN 公开站点接口客户端（积分榜 / 阵容 / 球队名单 / 赛程）。
 *
 * 2026-11 实测：`site.api.espn.com` 不需要 key，五大联赛、欧冠、J1、巴甲、阿甲、
 * 中超、荷甲、葡超、美职、澳超等都有整季数据；阵容在 `summary.rosters`，
 * 赛前公布（实测约赛前 1 小时，荷甲赛前 25 分钟已有名单）。
 *
 * 注意两点：
 *   1. 这是 ESPN 自己的 Web 接口，没有公开文档与授权条款，字段可能变；
 *      解析全部走可选链，坏数据按「这轮没拿到」处理，不影响其它链路。
 *   2. 它**没有伤停数据**（`/injuries` 恒为空数组），伤停继续走体彩官方 feed。
 */

const SCOREBOARD_URL = (slug, dateKey) =>
  `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${dateKey}`
const SUMMARY_URL = (slug, eventId) =>
  `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/summary?event=${eventId}`

const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
}

/** ESPN 的位置缩写 → 库里一直用的中文（和体彩/500.com 的写法保持一致）。 */
const POSITION_NAMES = {
  G: '门将',
  GK: '门将',
  D: '后卫',
  DF: '后卫',
  M: '中场',
  MF: '中场',
  F: '前锋',
  FW: '前锋',
  SUB: '替补',
}

/**
 * 体彩联赛名 → ESPN 联赛 slug。
 *
 * 只收实测 200 的 slug：`kor.1`、`jpn.2`、`jpn.league_cup`、`bra.copa_do_brasil`、
 * `afc.champions_2` 在 ESPN 侧返回 400，先不映射（对应比赛跳过阵容，不影响其它链路）。
 */
export const ESPN_LEAGUES = new Map([
  ['英格兰超级联赛', 'eng.1'],
  ['英超', 'eng.1'],
  ['英格兰冠军联赛', 'eng.2'],
  ['英冠', 'eng.2'],
  ['英格兰联赛杯', 'eng.league_cup'],
  ['西班牙甲级联赛', 'esp.1'],
  ['西甲', 'esp.1'],
  ['意大利甲级联赛', 'ita.1'],
  ['意甲', 'ita.1'],
  ['德国甲级联赛', 'ger.1'],
  ['德甲', 'ger.1'],
  ['德国乙级联赛', 'ger.2'],
  ['德国杯', 'ger.dfb_pokal'],
  ['法国甲级联赛', 'fra.1'],
  ['法甲', 'fra.1'],
  ['法国乙级联赛', 'fra.2'],
  ['法乙', 'fra.2'],
  ['荷兰甲级联赛', 'ned.1'],
  ['荷甲', 'ned.1'],
  ['荷兰乙级联赛', 'ned.2'],
  ['荷兰杯', 'ned.cup'],
  ['葡萄牙超级联赛', 'por.1'],
  ['葡超', 'por.1'],
  ['瑞典超级联赛', 'swe.1'],
  ['瑞超', 'swe.1'],
  ['挪威超级联赛', 'nor.1'],
  ['挪超', 'nor.1'],
  ['芬兰超级联赛', 'fin.1'],
  ['芬超', 'fin.1'],
  ['巴西甲级联赛', 'bra.1'],
  ['巴甲', 'bra.1'],
  ['阿根廷甲级联赛', 'arg.1'],
  ['阿甲', 'arg.1'],
  ['美国职业大联盟', 'usa.1'],
  ['美职', 'usa.1'],
  ['墨西哥超级联赛', 'mex.1'],
  ['墨超', 'mex.1'],
  ['中国足球超级联赛', 'chn.1'],
  ['中超', 'chn.1'],
  ['日本职业联赛', 'jpn.1'],
  ['J1', 'jpn.1'],
  ['澳大利亚超级联赛', 'aus.1'],
  ['澳超', 'aus.1'],
  ['欧洲冠军联赛', 'uefa.champions'],
  ['欧冠', 'uefa.champions'],
  ['欧罗巴联赛', 'uefa.europa'],
  ['欧联', 'uefa.europa'],
  ['欧洲协会联赛', 'uefa.europa.conf'],
  ['欧会杯', 'uefa.europa.conf'],
  ['亚洲冠军精英联赛', 'afc.champions'],
  ['亚冠', 'afc.champions'],
  ['南美解放者杯', 'conmebol.libertadores'],
])

export function espnLeagueSlug(leagueName) {
  return ESPN_LEAGUES.get(String(leagueName ?? '').trim()) ?? null
}

/** ESPN 的 `dates` 参数按 UTC 日期切，别用北京时间，否则凌晨场次会错一天。 */
export function toUtcDateKey(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

async function getJson(url, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const response = await fetchImpl(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`ESPN ${response.status}：${url}`)
  }
  return response.json()
}

/** 某联赛某 UTC 日期的全部赛事（含未开赛，字段与网页版一致）。 */
export async function fetchScoreboard(slug, dateKey, options) {
  const payload = await getJson(SCOREBOARD_URL(slug, dateKey), options)
  return Array.isArray(payload?.events) ? payload.events : []
}

/** 单场详情：`rosters` 就是首发+替补，`gameInfo` 有场地。 */
export async function fetchSummary(slug, eventId, options) {
  return getJson(SUMMARY_URL(slug, eventId), options)
}

export function competitorOf(event, homeAway) {
  const competitors = event?.competitions?.[0]?.competitors
  if (!Array.isArray(competitors)) {
    return null
  }
  return competitors.find((item) => item?.homeAway === homeAway) ?? null
}

/**
 * 把本地比赛对到 ESPN 赛事。
 *
 * 先按开赛时间（±12 分钟）筛；同一时间有多场时（周末晚场很常见），
 * 用体彩的英文缩写对 ESPN 的主/客队缩写算相似度——体彩的缩写和 ESPN 不是一套
 * （MAM/MAL、EXE/EXC），所以用编辑距离而不是全等，且要求「明显高于第二名」，
 * 对不唯一就放弃：宁可这轮不抓，也不要把阵容写到别的比赛上。
 *
 * @param {{kickoffAt?: string|Date, kickoff_at?: string|Date, homeCode?: string, awayCode?: string}} match
 * @param {Array} events
 */
export function pickEvent(
  match,
  events,
  { toleranceMs = 12 * 60_000, minSimilarity = 0.66, minMargin = 0.15 } = {},
) {
  const kickoff = new Date(match?.kickoffAt ?? match?.kickoff_at ?? '').getTime()
  if (!Number.isFinite(kickoff) || !Array.isArray(events)) {
    return null
  }

  const near = events.filter((event) => {
    const start = Date.parse(event?.date ?? '')
    return Number.isFinite(start) && Math.abs(start - kickoff) <= toleranceMs
  })

  if (near.length === 1) {
    return near[0]
  }
  if (near.length === 0) {
    return null
  }

  const homeCode = normalizeCode(match?.homeCode)
  const awayCode = normalizeCode(match?.awayCode)
  if (!homeCode && !awayCode) {
    return null
  }

  const scored = near
    .map((event) => {
      const home = competitorOf(event, 'home')
      const away = competitorOf(event, 'away')
      const score = Math.max(
        similarity(homeCode, home?.team?.abbreviation),
        similarity(awayCode, away?.team?.abbreviation),
      )
      return { event, score }
    })
    .sort((left, right) => right.score - left.score)

  const best = scored[0]
  const second = scored[1]
  if (!best || best.score < minSimilarity) {
    return null
  }
  if (second && best.score - second.score < minMargin) {
    return null
  }
  return best.event
}

function normalizeCode(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
}

/** 0~1：1 表示完全相同，按最长串长度归一化，避免短缩写被过度惩罚。 */
function similarity(left, right) {
  const a = normalizeCode(left)
  const b = normalizeCode(right)
  if (!a || !b) {
    return 0
  }
  if (a === b) {
    return 1
  }
  const distance = editDistance(a, b)
  return Math.max(0, 1 - distance / Math.max(a.length, b.length))
}

function editDistance(left, right) {
  const rows = left.length + 1
  const cols = right.length + 1
  let previous = Array.from({ length: cols }, (_, index) => index)
  for (let row = 1; row < rows; row += 1) {
    const current = [row]
    for (let col = 1; col < cols; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1
      current[col] = Math.min(previous[col] + 1, current[col - 1] + 1, previous[col - 1] + cost)
    }
    previous = current
  }
  return previous[cols - 1]
}

/**
 * 位置：优先用球员的「大位置」（`athlete.position`：G/D/M/F），
 * 它比阵容里的 `position` 稳定——赛前 `position` 常常只给 "SUB"，
 * 会把首发也标成替补。只有确实没进首发时才退回「替补」。
 */
function positionName(entry) {
  const candidates = [entry?.athlete?.position?.abbreviation, entry?.position?.abbreviation]
  for (const candidate of candidates) {
    const abbreviation = String(candidate ?? '').trim().toUpperCase()
    const label = POSITION_NAMES[abbreviation]
    if (label && label !== '替补') {
      return label
    }
  }
  if (entry?.starter !== true) {
    return '替补'
  }
  return String(entry?.athlete?.position?.name ?? entry?.position?.name ?? '').trim()
}

/**
 * 解析 ESPN 阵容。
 *
 * 只有两队都凑够 11 名首发才返回，否则当作「还没公布」——
 * 赛前 ESPN 会返回 `rosters: []` 或者空名单，不能把空阵容写进库。
 *
 * @returns {{home: Array|Object, away: Object, starters: {home:number,away:number}}|null}
 */
export function parseEspnLineup(summary) {
  const rosters = Array.isArray(summary?.rosters) ? summary.rosters : []
  if (rosters.length === 0) {
    return null
  }

  const toSide = (homeAway) => {
    const roster = rosters.find((item) => item?.homeAway === homeAway)
    if (!roster) {
      return null
    }
    const players = (Array.isArray(roster.roster) ? roster.roster : [])
      .map((entry) => ({
        name: String(entry?.athlete?.displayName ?? entry?.athlete?.fullName ?? '').trim(),
        no: Number.isFinite(Number(entry?.jersey)) ? Number(entry.jersey) : null,
        position: positionName(entry),
        starter: entry?.starter === true,
      }))
      .filter((player) => player.name !== '')

    const starters = players.filter((player) => player.starter).length
    if (starters < 11) {
      return null
    }
    return {
      formation: roster.formation ? String(roster.formation) : null,
      confirmed: true,
      players,
    }
  }

  const home = toSide('home')
  const away = toSide('away')
  if (!home || !away) {
    return null
  }

  return {
    home,
    away,
    starters: {
      home: home.players.filter((player) => player.starter).length,
      away: away.players.filter((player) => player.starter).length,
    },
  }
}
