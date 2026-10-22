import {
  type MatchDetail,
  type MatchFeedMatch,
  type MatchLineupPlayer,
  type MatchLineupTeam,
} from '../../api/matchDetailApi'

/**
 * 纯函数：接口返回的原始 feed → 页面视图模型。
 *
 * 上游字段可能整体缺失、也可能单条缺失，这里全部给默认值，
 * 页面只负责"有就渲染、没有就显示暂无数据"。
 */

export type DetailMatchItem = {
  date: string
  league: string
  home: string
  away: string
  score: string
  half: string
  /** 从所查球队视角看的结果：胜 / 平 / 负；队名对不上时为空 */
  tag: string
}

export type DetailFixture = {
  date: string
  time: string
  league: string
  home: string
  away: string
}

export type DetailPerson = {
  name: string
  position: string
  /** 伤 / 停赛 */
  kind: string
}

export type DetailTableRow = {
  team: string
  ranking: string
  points: string
  played: string
}

export type DetailShooter = {
  name: string
  goals: number
  assists: number
}

export type DetailLineupPlayer = {
  name: string
  number: string
  position: string
}

export type DetailLineupTeam = {
  teamName: string
  formation: string
  /** false = 预测阵容 */
  confirmed: boolean
  starters: DetailLineupPlayer[]
  substitutes: DetailLineupPlayer[]
}

export type DetailGroup<T> = {
  teamName: string
  items: T[]
}

export type MatchDetailView = {
  league: string
  kickoff: string
  statusLabel: string
  homeName: string
  awayName: string
  scoreText: string
  htftText: string
  h2h: {
    summary: string
    items: DetailMatchItem[]
  }
  injuries: {
    home: DetailGroup<DetailPerson>
    away: DetailGroup<DetailPerson>
  }
  recent: {
    home: DetailGroup<DetailMatchItem>
    away: DetailGroup<DetailMatchItem>
  }
  upcoming: {
    home: DetailGroup<DetailFixture>
    away: DetailGroup<DetailFixture>
  }
  table: {
    tournament: string
    rows: DetailTableRow[]
  }
  shooters: {
    home: DetailGroup<DetailShooter>
    away: DetailGroup<DetailShooter>
  }
  lineup: {
    home: DetailLineupTeam | null
    away: DetailLineupTeam | null
  }
}

const STATUS_LABELS: Record<string, string> = {
  scheduled: '未开赛',
  live: '进行中',
  finished: '已结束',
  cancelled: '已取消',
  unknown: '状态未知',
}

const HTFT_LABELS: Record<string, string> = { h: '主胜', d: '平', a: '客胜' }

const EMPTY = '暂无数据'

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value)
}

function shortDate(value: unknown): string {
  const raw = text(value)
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(5, 10) : raw
}

function scoreOf(value: unknown): string {
  const raw = text(value)
  return /^\d+:\d+$/.test(raw) ? raw : ''
}

/** ISO（UTC）→ 北京时间的 MM-DD HH:mm */
function formatKickoff(iso?: string | null): string {
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
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`
}

function formatHtft(htft?: string | null): string {
  const raw = text(htft)
  if (raw.length !== 2) {
    return ''
  }
  const half = HTFT_LABELS[raw[0]]
  const full = HTFT_LABELS[raw[1]]
  return half && full ? `半场${half} · 全场${full}` : ''
}

function resultTag(match: MatchFeedMatch, teamName: string): string {
  if (!teamName) {
    return ''
  }
  const [homeGoals, awayGoals] = text(match.fullCourtGoal).split(':').map(Number)
  if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) {
    return ''
  }
  if (match.homeTeamShortName === teamName) {
    return homeGoals > awayGoals ? '胜' : homeGoals === awayGoals ? '平' : '负'
  }
  if (match.awayTeamShortName === teamName) {
    return awayGoals > homeGoals ? '胜' : awayGoals === homeGoals ? '平' : '负'
  }
  return ''
}

function toMatchItem(match: MatchFeedMatch, teamName: string): DetailMatchItem {
  return {
    date: shortDate(match.matchDate),
    league: text(match.tournamentShortName),
    home: text(match.homeTeamShortName) || '主队',
    away: text(match.awayTeamShortName) || '客队',
    score: scoreOf(match.fullCourtGoal) || '-',
    half: scoreOf(match.halfTimeGoal),
    tag: resultTag(match, teamName),
  }
}

/** 未来赛程的字段和赛果不同：只有 matchDateTime，没有比分。 */
function toFixture(raw: unknown): DetailFixture | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const item = raw as Record<string, unknown>
  const dateTime = text(item.matchDateTime)
  if (!dateTime) {
    return null
  }
  return {
    date: dateTime.slice(5, 10),
    time: dateTime.slice(11, 16),
    league: text(item.tournamentShortName),
    home: text(item.homeTeamShortName) || '主队',
    away: text(item.awayTeamShortName) || '客队',
  }
}

export function buildDetailView(
  detail?: MatchDetail | null,
  fallback?: { homeTeam?: string; awayTeam?: string; league?: string; time?: string },
): MatchDetailView | null {
  if (!detail) {
    return null
  }

  const feeds: MatchDetail['feeds'] = detail.feeds ?? {}
  const homeName = detail.home?.name || fallback?.homeTeam || '主队'
  const awayName = detail.away?.name || fallback?.awayTeam || '客队'

  const hasScore = detail.home?.score !== null && detail.away?.score !== null
  const scoreText = hasScore
    ? `${detail.home?.score ?? 0} : ${detail.away?.score ?? 0}`
    : 'VS'

  const h2hStats = feeds.history?.statistics
  const h2hSummary = h2hStats?.totalLegCnt
    ? `近 ${h2hStats.totalLegCnt} 场交锋：胜 ${text(h2hStats.winProbability) || '-'} / 平 ${text(h2hStats.drawProbability) || '-'} / 负 ${text(h2hStats.lossProbability) || '-'}（${text(h2hStats.teamShortName) || homeName}视角）`
    : ''

  const injuryGroup = (side: 'home' | 'away', teamName: string): DetailGroup<DetailPerson> => {
    const block = feeds.injury?.[side]
    const people = Array.isArray(block?.injuriesAndSuspensionsList)
      ? block.injuriesAndSuspensionsList
      : []
    return {
      teamName: text(block?.teamShortName) || teamName,
      items: people.map((person) => ({
        name: text(person.personName) || '未知球员',
        position: text(person.playerPositionDesc),
        kind: person.suspensionFlag === 1 ? '停赛' : '伤',
      })),
    }
  }

  const recentGroup = (side: 'home' | 'away', teamName: string): DetailGroup<DetailMatchItem> => {
    const list = feeds.result?.[side]?.matchList
    return {
      teamName,
      items: Array.isArray(list) ? list.slice(0, 5).map((item) => toMatchItem(item, teamName)) : [],
    }
  }

  const upcomingGroup = (side: 'home' | 'away', teamName: string): DetailGroup<DetailFixture> => {
    const list = feeds.future?.[side]?.matchList
    return {
      teamName,
      items: Array.isArray(list)
        ? list
            .map(toFixture)
            .filter((item): item is DetailFixture => item !== null)
            .slice(0, 4)
        : [],
    }
  }

  const shooterGroup = (side: 'home' | 'away', teamName: string): DetailGroup<DetailShooter> => {
    const block = feeds.shooter?.[side]
    const list = Array.isArray(block?.playerList) ? block.playerList : []
    return {
      teamName: text(block?.teamShortName) || teamName,
      items: list.slice(0, 5).map((person) => ({
        name: text(person.personName) || '未知球员',
        goals: Number(person.goalCnt) || 0,
        assists: Number(person.assistCnt) || 0,
      })),
    }
  }

  const tableRows = Array.isArray(feeds.tables?.tables) ? feeds.tables.tables : []

  const toLineupTeam = (team: MatchLineupTeam | null | undefined, fallbackName: string) => {
    if (!team || (team.starters?.length ?? 0) === 0) {
      return null
    }
    const mapPlayer = (player: MatchLineupPlayer) => ({
      name: player.name,
      number: player.number === null || player.number === undefined ? '' : String(player.number),
      position: player.position ?? '',
    })
    return {
      teamName: team.teamName || fallbackName,
      formation: team.formation ?? '',
      confirmed: team.confirmed === true,
      starters: (team.starters ?? []).map(mapPlayer),
      substitutes: (team.substitutes ?? []).map(mapPlayer),
    }
  }

  return {
    league: text(detail.league) || fallback?.league || '未知赛事',
    kickoff: formatKickoff(detail.kickoffAt) || text(fallback?.time),
    statusLabel: STATUS_LABELS[text(detail.status)] ?? '状态未知',
    homeName,
    awayName,
    scoreText,
    htftText: formatHtft(detail.htft),
    h2h: {
      summary: h2hSummary,
      items: Array.isArray(feeds.history?.matchList)
        ? feeds.history.matchList.slice(0, 5).map((item) => toMatchItem(item, homeName))
        : [],
    },
    injuries: { home: injuryGroup('home', homeName), away: injuryGroup('away', awayName) },
    recent: { home: recentGroup('home', homeName), away: recentGroup('away', awayName) },
    upcoming: { home: upcomingGroup('home', homeName), away: upcomingGroup('away', awayName) },
    table: {
      tournament: text(feeds.tables?.tournamentShortName),
      rows: tableRows.map((row) => ({
        team: text(row.teamShortName) || '-',
        ranking: text(row.ranking) || '-',
        points: text(row.points) || '-',
        played: text(row.totalLegCnt) || '-',
      })),
    },
    shooters: { home: shooterGroup('home', homeName), away: shooterGroup('away', awayName) },
    lineup: {
      home: toLineupTeam(detail.lineup?.home, homeName),
      away: toLineupTeam(detail.lineup?.away, awayName),
    },
  }
}

export { EMPTY }
