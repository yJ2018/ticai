/**
 * 分析提示词构建（纯函数，可单测）。
 *
 * 设计目标：
 * 1. 客户端只传 matchId + pool，提示词版本随服务端发布，不再受前端缓存影响；
 * 2. 同样的输入产出**逐字节相同**的 system 段，方便命中 DeepSeek 上下文缓存；
 * 3. 严格控制长度：官方数据只保留有预测价值的字段，缺失的直接不写。
 */

export const POOL_KEYS = ['had', 'crs', 'ttg', 'hafu', 'mixed']

export const POOL_LABELS = {
  had: '胜平负',
  crs: '比分',
  ttg: '总进球数',
  hafu: '半全场',
  mixed: '混合过关',
}

const POOL_FOCUS = {
  had: '重点给出胜/平/负推荐，并结合让球盘口说明是否值得考虑让球选项',
  crs: '重点给出最可能的 2-3 个比分，按概率从高到低排列',
  ttg: '重点给出总进球数区间（0-1 球 / 2-3 球 / 4 球以上），并给出最可能的具体进球数',
  hafu: '重点给出半全场组合推荐，并说明对上半场走势的判断',
  mixed: '从胜平负、总进球、比分、半全场中挑出 1-2 个最有价值的选项，不要面面俱到',
}

/** 固定不变的前缀，保持稳定以命中提示词缓存。 */
const SYSTEM_PROMPT = `你是一名资深足球比赛分析师，服务中国竞彩用户。
你会收到：比赛信息、当前玩法、该玩法赔率、体彩官方数据（伤停/交锋/近况/排名，可能部分缺失）、比赛地天气（可能缺失）。

要求：
1. 状态与战术：只依据给出的近期战绩与交锋，不臆测未提供的信息；
2. 伤停：只用给出的名单，没有就写「暂无可靠伤停信息」，严禁编造球员姓名或伤情；
3. 主客场与赛程密度；
4. 天气：有就分析对节奏的影响，没有就说明缺失；
5. 赔率：结合当前玩法解读市场倾向，不声称有内幕消息；
6. 官方数据优先，缺失项直接说明，不要用常识补全。

输出格式（严格遵守，不要 Markdown 表格、不要输出 JSON）：
【分析】
1. 状态与风格：...
2. 伤停：...
3. 主客场与赛程：...
4. 天气影响：...
5. 赔率解读：...
【预测】
推荐选项：...
比分参考：...
信心等级：高/中/低
理由：一句话总结
以上为 AI 分析，仅供参考，不构成投注建议。

中文，600-800 字，结论明确，不要模棱两可。`

const HAD_KEYS = [
  ['h', '胜'],
  ['d', '平'],
  ['a', '负'],
]

const TTG_KEYS = [
  ['s0', '0球'],
  ['s1', '1球'],
  ['s2', '2球'],
  ['s3', '3球'],
  ['s4', '4球'],
  ['s5', '5球'],
  ['s6', '6球'],
  ['s7', '7+'],
]

const HAFU_KEYS = [
  ['hh', '胜胜'],
  ['hd', '胜平'],
  ['ha', '胜负'],
  ['dh', '平胜'],
  ['dd', '平平'],
  ['da', '平负'],
  ['ah', '负胜'],
  ['ad', '负平'],
  ['aa', '负负'],
]

/** 比分只取最常见的 9 个具体比分 + 3 个「其它」，31 个全发太费 token。 */
const CRS_KEYS = [
  ['s01s00', '1:0'],
  ['s02s00', '2:0'],
  ['s02s01', '2:1'],
  ['s00s00', '0:0'],
  ['s01s01', '1:1'],
  ['s02s02', '2:2'],
  ['s00s01', '0:1'],
  ['s00s02', '0:2'],
  ['s01s02', '1:2'],
  ['s1sh', '胜其它'],
  ['s1sd', '平其它'],
  ['s1sa', '负其它'],
]

const STATUS_LABELS = {
  scheduled: '未开赛',
  live: '进行中',
  finished: '已结束',
  cancelled: '已取消',
}

function text(value) {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value)
}

function pairText(record, keys) {
  const parts = []
  for (const [key, label] of keys) {
    const value = text(record?.[key])
    if (value) {
      parts.push(`${label}${value}`)
    }
  }
  return parts.join(' ')
}

/** 北京时间 MM-DD HH:mm */
function beijingTime(iso) {
  if (!iso) {
    return ''
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`
}

export function formatOdds(odds, pool) {
  if (!odds || typeof odds !== 'object') {
    return ''
  }

  const sections = []
  const push = (label, body) => {
    if (body) {
      sections.push(`${label} ${body}`)
    }
  }

  const wantsHad = pool === 'had' || pool === 'mixed'
  const wantsTtg = pool === 'ttg' || pool === 'mixed'
  const wantsHafu = pool === 'hafu' || pool === 'mixed'
  const wantsCrs = pool === 'crs'

  if (wantsHad) {
    push('胜平负', pairText(odds.had, HAD_KEYS))
    const goalLine = text(odds.hhad?.goalLine ?? odds.hhad?.goalLineValue)
    push(`让球${goalLine ? `(${goalLine})` : ''}`, pairText(odds.hhad, HAD_KEYS))
  }
  if (wantsTtg) {
    push('总进球', pairText(odds.ttg, TTG_KEYS))
  }
  if (wantsHafu) {
    push('半全场', pairText(odds.hafu, HAFU_KEYS))
  }
  if (wantsCrs) {
    push('比分', pairText(odds.crs, CRS_KEYS))
  }

  return sections.join('；')
}

function formatScore(value) {
  const raw = text(value)
  return /^\d+:\d+$/.test(raw) ? raw : ''
}

/** 交锋：最多 3 场，只保留 日期+比分。 */
function formatH2H(feeds) {
  const list = feeds?.history?.matchList
  if (!Array.isArray(list) || list.length === 0) {
    return ''
  }

  const stat = feeds.history.statistics
  const summary = stat?.totalLegCnt
    ? `近${stat.totalLegCnt}场 胜${text(stat.winProbability) || '-'} 平${text(stat.drawProbability) || '-'} 负${text(stat.lossProbability) || '-'}`
    : ''

  const items = list
    .slice(0, 3)
    .map((item) => {
      const score = formatScore(item.fullCourtGoal)
      const date = text(item.matchDate).slice(5)
      return score ? `${date} ${text(item.homeTeamShortName)}${score}${text(item.awayTeamShortName)}` : ''
    })
    .filter(Boolean)

  return [summary, items.join('、')].filter(Boolean).join('｜')
}

/** 伤停：每队最多 4 人，只写 名字(位置)+伤/停。 */
function formatInjuries(feeds, homeName, awayName) {
  const groups = []

  for (const [side, fallbackName] of [
    ['home', homeName],
    ['away', awayName],
  ]) {
    const block = feeds?.injury?.[side]
    if (!block || typeof block !== 'object') {
      continue
    }
    const name = text(block.teamShortName) || fallbackName
    const list = Array.isArray(block.injuriesAndSuspensionsList) ? block.injuriesAndSuspensionsList : []
    if (list.length === 0) {
      groups.push(`${name}无`)
      continue
    }
    const people = list
      .slice(0, 4)
      .map((person) => {
        const position = text(person.playerPositionDesc)
        const kind = Number(person.suspensionFlag) === 1 ? '停' : '伤'
        return `${text(person.personName)}${position ? `(${position})` : ''}${kind}`
      })
      .filter(Boolean)
    groups.push(`${name} ${people.join('、')}`)
  }

  return groups.length > 0 ? groups.join('｜') : ''
}

/** 近况：每队最多 4 场，只写 日期 + 胜平负 + 比分。 */
function formatRecent(feeds, homeName, awayName) {
  const groups = []

  for (const [side, name] of [
    ['home', homeName],
    ['away', awayName],
  ]) {
    const list = feeds?.result?.[side]?.matchList
    if (!Array.isArray(list) || list.length === 0) {
      continue
    }
    const items = list
      .slice(0, 4)
      .map((item) => {
        const score = formatScore(item.fullCourtGoal)
        if (!score) {
          return ''
        }
        const [homeGoals, awayGoals] = score.split(':').map(Number)
        let tag = ''
        if (item.homeTeamShortName === name) {
          tag = homeGoals > awayGoals ? '胜' : homeGoals === awayGoals ? '平' : '负'
        } else if (item.awayTeamShortName === name) {
          tag = awayGoals > homeGoals ? '胜' : awayGoals === homeGoals ? '平' : '负'
        }
        return `${text(item.matchDate).slice(5)}${tag}${score}`
      })
      .filter(Boolean)
    if (items.length > 0) {
      groups.push(`${name} ${items.join(' ')}`)
    }
  }

  return groups.length > 0 ? groups.join('｜') : ''
}

/** 阵容：只写首发名单与阵型，替补不进提示词（省 token）。 */
function formatLineup(lineup) {
  if (!lineup) {
    return ''
  }

  const groups = []
  for (const [label, block] of [
    ['主', lineup.home],
    ['客', lineup.away],
  ]) {
    if (!block || !Array.isArray(block.starters) || block.starters.length === 0) {
      continue
    }
    const formation = text(block.formation) ? `${text(block.formation)} ` : ''
    const tag = block.confirmed ? '' : '（预测）'
    groups.push(`${label} ${formation}${tag}${block.starters.join('、')}`)
  }

  return groups.join('｜')
}

function formatTable(feeds) {  const rows = feeds?.tables?.tables
  if (!Array.isArray(rows) || rows.length === 0) {
    return ''
  }
  return rows
    .slice(0, 4)
    .map((row) => `${text(row.teamShortName)}第${text(row.ranking)}(${text(row.points)}分)`)
    .join('｜')
}

/** 天气压成一行；缺失返回空串，由调用方决定不写这一行。 */
export function formatWeather(weather) {
  if (!weather || weather.available === false) {
    return ''
  }
  const parts = []
  if (weather.city) {
    parts.push(weather.city)
  }
  const current = weather.current
  if (current) {
    if (current.temperature !== null && current.temperature !== undefined) {
      parts.push(`${current.temperature}℃`)
    }
    if (current.weather) {
      parts.push(current.weather)
    }
    if (current.humidity !== null && current.humidity !== undefined) {
      parts.push(`湿度${current.humidity}%`)
    }
  }
  const kickoff = weather.kickoff
  if (kickoff && kickoff.precipitationProbability !== null && kickoff.precipitationProbability !== undefined) {
    parts.push(`开赛降水${kickoff.precipitationProbability}%`)
  }
  return parts.join(' ')
}

export function weatherLabel(weather) {
  if (!weather || weather.available === false) {
    return '比赛地天气未获取'
  }
  const current = weather.current
  const temperature =
    current && current.temperature !== null && current.temperature !== undefined
      ? `${current.temperature}℃ `
      : ''
  return `${weather.city ?? ''} ${temperature}${current?.weather ?? ''}`.trim()
}

/**
 * @param {object} input
 * @param {{matchNo?:string, league:string, homeName:string, awayName:string, kickoffAt:string, status?:string}} input.match
 * @param {object|null} input.odds 最新赔率快照（原始上游结构）
 * @param {object} input.feeds 对战数据（history/injury/result/tables…）
 * @param {object|null} input.weather 场馆天气
 * @param {string} input.pool 玩法
 */
export function buildAnalysisPrompt({ match, odds, feeds = {}, weather = null, pool = 'ttg', lineup = null }) {
  const homeName = match.homeName || '主队'
  const awayName = match.awayName || '客队'
  const kickoff = beijingTime(match.kickoffAt)
  const status = STATUS_LABELS[match.status] ?? ''

  const lines = [
    `比赛：${match.matchNo ? `${match.matchNo} ` : ''}${match.league || '未知赛事'} ${homeName} vs ${awayName}${kickoff ? ` ${kickoff}` : ''}${status ? `（${status}）` : ''}`,
    `玩法：${POOL_LABELS[pool] ?? pool}（${POOL_FOCUS[pool] ?? ''}）`,
  ]

  const oddsText = formatOdds(odds, pool)
  if (oddsText) {
    lines.push(`赔率：${oddsText}`)
  }

  const h2h = formatH2H(feeds)
  if (h2h) {
    lines.push(`交锋：${h2h}`)
  }

  const injuries = formatInjuries(feeds, homeName, awayName)
  if (injuries) {
    lines.push(`伤停：${injuries}`)
  }

  const lineupText = formatLineup(lineup)
  if (lineupText) {
    lines.push(`阵容：${lineupText}`)
  }

  const recent = formatRecent(feeds, homeName, awayName)
  if (recent) {
    lines.push(`近况：${recent}`)
  }

  const table = formatTable(feeds)
  if (table) {
    lines.push(`排名：${table}`)
  }

  const weatherText = formatWeather(weather)
  if (weatherText) {
    lines.push(`天气：${weatherText}`)
  }

  const user = `${lines.join('\n')}\n\n按系统提示的格式输出分析与预测。`

  return {
    system: SYSTEM_PROMPT,
    user,
    chars: user.length,
  }
}
