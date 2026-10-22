import { apiUrl } from './base'
import { request } from './httpClient'

/**
 * 对战详情：来自新 API 的 /api/match-detail。
 *
 * 注意：这是"增强信息"，任何失败（接口还没部署、比赛没抓过、网络错误）
 * 都必须静默降级为 null，不能影响 AI 分析本身。
 */

export type MatchFeedMatch = {
  matchDate?: string
  fullCourtGoal?: string
  halfTimeGoal?: string
  homeTeamShortName?: string
  awayTeamShortName?: string
  tournamentShortName?: string
}

export type MatchFeedHistory = {
  matchList?: MatchFeedMatch[]
  statistics?: {
    totalLegCnt?: number
    winProbability?: string
    drawProbability?: string
    lossProbability?: string
    teamShortName?: string
  }
}

export type MatchFeedPerson = {
  personName?: string
  playerPositionDesc?: string
  injuryFlag?: number
  suspensionFlag?: number
  uniformNo?: string
}

export type MatchFeedSide<T> = {
  teamShortName?: string
  sportteryTeamId?: number
} & T

export type MatchFeedInjury = {
  home?: MatchFeedSide<{ injuriesAndSuspensionsList?: MatchFeedPerson[] }>
  away?: MatchFeedSide<{ injuriesAndSuspensionsList?: MatchFeedPerson[] }>
}

export type MatchFeedResult = {
  home?: MatchFeedSide<{ matchList?: MatchFeedMatch[] }>
  away?: MatchFeedSide<{ matchList?: MatchFeedMatch[] }>
}

/** 未来赛程字段和赛果不同：只有 matchDateTime，没有比分 */
export type MatchFeedFuture = {
  home?: MatchFeedSide<{ matchList?: Array<Record<string, unknown>> }>
  away?: MatchFeedSide<{ matchList?: Array<Record<string, unknown>> }>
}

export type MatchFeedTables = {
  tournamentShortName?: string
  seasonName?: string
  tables?: Array<{
    teamShortName?: string
    ranking?: string
    points?: string
    totalLegCnt?: number
  }>
}

export type MatchFeedShooterPerson = {
  personName?: string
  goalCnt?: number
  assistCnt?: number
  appearanceCnt?: number
}

export type MatchFeedShooter = {
  home?: MatchFeedSide<{ playerList?: MatchFeedShooterPerson[] }>
  away?: MatchFeedSide<{ playerList?: MatchFeedShooterPerson[] }>
}

export type MatchLineupPlayer = {
  name: string
  number: number | null
  position: string | null
  starter: boolean
}

export type MatchLineupTeam = {
  teamName: string | null
  formation: string | null
  coach: string | null
  /** true = 官方名单，false = 预测阵容 */
  confirmed: boolean
  source: string | null
  capturedAt: string | null
  starters: MatchLineupPlayer[]
  substitutes: MatchLineupPlayer[]
}

export type MatchLineup = {
  home: MatchLineupTeam | null
  away: MatchLineupTeam | null
}

export type MatchDetail = {
  matchId: number
  league: string | null
  kickoffAt: string | null
  status: string | null
  sellStatus?: string | null
  home: { name: string | null; score: number | null; halfScore: number | null }
  away: { name: string | null; score: number | null; halfScore: number | null }
  htft: string | null
  resultSource?: string | null
  feeds: {
    history?: MatchFeedHistory | null
    injury?: MatchFeedInjury | null
    result?: MatchFeedResult | null
    future?: MatchFeedFuture | null
    feature?: unknown
    tables?: MatchFeedTables | null
    shooter?: MatchFeedShooter | null
  }
  fetchedAt?: Record<string, string | null>
  /** 阵容；没抓到时为 null */
  lineup?: MatchLineup | null
  /** 后端标注的缺失板块，例如 ['shooter.home'] */
  missing?: string[]
}

export async function getMatchDetail(
  matchId: number,
  signal?: AbortSignal,
): Promise<MatchDetail | null> {
  if (!matchId) {
    return null
  }

  try {
    const payload = await request<{ success: boolean; data?: MatchDetail }>(
      apiUrl(`/api/match-detail?matchId=${matchId}`),
      { signal, timeoutMs: 8_000 },
    )
    return payload.success && payload.data ? payload.data : null
  } catch {
    // 接口未部署（404）、数据库未连通（503）、超时：一律当作"没有这份数据"
    return null
  }
}
