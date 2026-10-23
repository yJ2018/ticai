import { getMatchCalculator } from '../api'
import { type MatchItem, type MatchPoolKey } from '../domain/sporttery'

export type MatchPoolType = MatchPoolKey

export type MatchCardOption = {
  key: string
  label: string
  value: string
}

export type MatchCardOptionGroup = {
  key: string
  columns: number
  rowLabel?: string
  options: MatchCardOption[]
}

export type MatchCardMixedSection = {
  key: string
  title: string
  poolType: 'hafu' | 'ttg' | 'crs'
  groups: MatchCardOptionGroup[]
}

/** 全玩法原始赔率：一键串关的模型需要 1X2 / 总进球，而不只是当前玩法。 */
export type MatchMarkets = {
  had?: MatchItem['had']
  hhad?: MatchItem['hhad']
  ttg?: MatchItem['ttg']
  crs?: MatchItem['crs']
  hafu?: MatchItem['hafu']
}

export type MatchCard = {
  id: number
  title: string
  subtitle: string
  time: string
  oddsSummary: string
  homeTeam?: string
  awayTeam?: string
  homeTeamId?: number
  matchNo?: string
  /** 销售日（期号所属的那一天）：一键串关默认只串当天 */
  businessDate?: string
  markets?: MatchMarkets
  optionGroups?: MatchCardOptionGroup[]
  mixedSections?: MatchCardMixedSection[]
}

export const matchService = {
  async getMatchCards(poolType: MatchPoolType = 'mixed') {
    const data = await getMatchCalculator(poolType)
    const cards = data.matchInfoList.flatMap((group) =>
      group.subMatchList.map((match) => toMatchCard(match, group.businessDate, poolType)),
    )
    return cards
  },
}

function toMatchCard(match: MatchItem, businessDate: string, poolType: MatchPoolType): MatchCard {
  const league = match.leagueAllName ?? '未知联赛'
  const home = match.homeTeamAbbName ?? '主队'
  const away = match.awayTeamAbbName ?? '客队'
  // 跨零点的场次归在前一天的期号里，展示时间要用真实比赛日
  const kickoffDate = match.matchDate || businessDate
  const kickoff = `${kickoffDate} ${match.matchTime ?? '--:--:--'}`

  return {
    id: match.matchId,
    title: `${home} vs ${away}`,
    subtitle: league,
    time: kickoff,
    oddsSummary: formatSummaryByPool(match, poolType),
    homeTeam: home,
    awayTeam: away,
    homeTeamId: match.homeTeamId,
    matchNo: match.matchNumStr,
    businessDate: businessDate.slice(0, 10),
    markets: {
      had: match.had,
      hhad: match.hhad,
      ttg: match.ttg,
      crs: match.crs,
      hafu: match.hafu,
    },
    optionGroups: toOptionGroups(match, poolType),
    mixedSections: toMixedSections(match, poolType),
  }
}

function formatSummaryByPool(match: MatchItem, poolType: MatchPoolType) {
  if (poolType === 'had') {
    return formatHadSummary(match.had, match.hhad)
  }

  if (poolType === 'crs') {
    return formatCrsPart(match.crs) || '比分赔率: 暂无'
  }

  if (poolType === 'ttg') {
    return formatTtgPart(match.ttg) || '总进球赔率: 暂无'
  }

  if (poolType === 'hafu') {
    return formatHafuPart(match.hafu) || '半全场赔率: 暂无'
  }

  return formatMixedSummary(match)
}

function formatMixedSummary(match: MatchItem) {
  const chunks = [
    formatHadSummary(match.had, match.hhad),
    formatHafuPart(match.hafu),
    formatCrsPart(match.crs),
    formatTtgPart(match.ttg),
  ].filter(Boolean)

  return chunks.length > 0 ? chunks.join(' | ') : '赔率: 暂无'
}

function formatHadSummary(had: MatchItem['had'], hhad: MatchItem['hhad']) {
  const hadText = had ? `胜平负 ${had.h ?? '--'}/${had.d ?? '--'}/${had.a ?? '--'}` : ''
  const hhadText = hhad
    ? `让球(${hhad.goalLine ?? hhad.goalLineValue ?? '--'}) ${hhad.h ?? '--'}/${hhad.d ?? '--'}/${hhad.a ?? '--'}`
    : ''
  return [hadText, hhadText].filter(Boolean).join(' ')
}

function formatHafuPart(hafu: MatchItem['hafu']) {
  if (!hafu) {
    return ''
  }
  const picks = ['hh', 'dd', 'aa'] as const
  const parts = picks
    .map((key) => ({ key, value: hafu[key] }))
    .filter((item) => typeof item.value === 'string' && item.value.length > 0)
    .map((item) => `${formatHafuKey(item.key)}:${item.value}`)

  return parts.length > 0 ? `半全场 ${parts.join('/')}` : ''
}

function formatCrsPart(crs: MatchItem['crs']) {
  if (!crs) {
    return ''
  }
  const keys = ['s00s00', 's01s00', 's02s01'] as const
  const parts = keys
    .map((key) => ({ key, value: crs[key] }))
    .filter((item) => typeof item.value === 'string' && item.value.length > 0)
    .map((item) => `${formatScoreKey(item.key)}:${item.value}`)

  return parts.length > 0 ? `比分 ${parts.join('/')}` : ''
}

function formatTtgPart(ttg: MatchItem['ttg']) {
  if (!ttg) {
    return ''
  }
  const keys = ['s0', 's1', 's2', 's3'] as const
  const parts = keys
    .map((key) => ({ key, value: ttg[key] }))
    .filter((item) => typeof item.value === 'string' && item.value.length > 0)
    .map((item) => `${keyToGoal(item.key)}:${item.value}`)

  return parts.length > 0 ? `总进球 ${parts.join('/')}` : ''
}

function formatHafuKey(key: 'hh' | 'hd' | 'ha' | 'dh' | 'dd' | 'da' | 'ah' | 'ad' | 'aa') {
  const map = {
    hh: '胜胜',
    hd: '胜平',
    ha: '胜负',
    dh: '平胜',
    dd: '平平',
    da: '平负',
    ah: '负胜',
    ad: '负平',
    aa: '负负',
  } as const
  return map[key]
}

function formatScoreKey(key: 's00s00' | 's01s00' | 's02s01') {
  const map = {
    s00s00: '0:0',
    s01s00: '1:0',
    s02s01: '2:1',
  } as const
  return map[key]
}

function keyToGoal(key: 's0' | 's1' | 's2' | 's3') {
  const map = {
    s0: '0球',
    s1: '1球',
    s2: '2球',
    s3: '3球',
  } as const
  return map[key]
}

function toOptionGroups(match: MatchItem, poolType: MatchPoolType): MatchCardOptionGroup[] {
  if (poolType === 'had') {
    return toHadOptionGroups(match.had, match.hhad)
  }

  if (poolType === 'mixed') {
    return toHadOptionGroups(match.had, match.hhad)
  }

  if (poolType === 'crs') {
    return CRS_OPTION_GROUPS.map((group) => ({
      key: group.key,
      columns: 5,
      options: group.options.map((item) => ({
        key: item.key,
        label: item.label,
        value: getOddText(match.crs, item.key),
      })),
    }))
  }

  if (poolType === 'ttg') {
    return [
      {
        key: 'ttg',
        columns: 4,
        options: TTG_OPTION_ORDER.map((item) => ({
          key: item.key,
          label: item.label,
          value: getOddText(match.ttg, item.key),
        })),
      },
    ]
  }

  if (poolType === 'hafu') {
    return [
      {
        key: 'hafu',
        columns: 3,
        options: HAFU_OPTION_ORDER.map((item) => ({
          key: item.key,
          label: item.label,
          value: getOddText(match.hafu, item.key),
        })),
      },
    ]
  }

  return []
}

function toMixedSections(match: MatchItem, poolType: MatchPoolType): MatchCardMixedSection[] {
  if (poolType !== 'mixed') {
    return []
  }

  return [
    {
      key: 'mixed-hafu',
      title: '半全场胜平负',
      poolType: 'hafu',
      groups: [
        {
          key: 'mixed-hafu-group',
          columns: 3,
          options: HAFU_OPTION_ORDER.map((item) => ({
            key: item.key,
            label: item.label,
            value: getOddText(match.hafu, item.key),
          })),
        },
      ],
    },
    {
      key: 'mixed-ttg',
      title: '总进球',
      poolType: 'ttg',
      groups: [
        {
          key: 'mixed-ttg-group',
          columns: 4,
          options: TTG_OPTION_ORDER.map((item) => ({
            key: item.key,
            label: item.label,
            value: getOddText(match.ttg, item.key),
          })),
        },
      ],
    },
    {
      key: 'mixed-crs',
      title: '比分',
      poolType: 'crs',
      groups: CRS_OPTION_GROUPS.map((group) => ({
        key: group.key,
        columns: 5,
        options: group.options.map((item) => ({
          key: item.key,
          label: item.label,
          value: getOddText(match.crs, item.key),
        })),
      })),
    },
  ]
}

function toHadOptionGroups(had: MatchItem['had'], hhad: MatchItem['hhad']) {
  const groups: MatchCardOptionGroup[] = []

  if (had) {
    groups.push({
      key: 'had',
      columns: 3,
      rowLabel: formatGoalLineTag(had.goalLine ?? had.goalLineValue ?? '0'),
      options: HAD_OPTION_ORDER.map((item) => ({
        key: item.key,
        label: item.label,
        value: getOddText(had, item.key),
      })),
    })
  }

  if (hhad) {
    groups.push({
      key: 'hhad',
      columns: 3,
      rowLabel: formatGoalLineTag(hhad.goalLine ?? hhad.goalLineValue ?? '-'),
      options: HAD_OPTION_ORDER.map((item) => ({
        key: `rq-${item.key}`,
        label: item.label,
        value: getOddText(hhad, item.key),
      })),
    })
  }

  return groups
}

function getOddText(record: Record<string, unknown> | undefined, key: string) {
  if (!record) {
    return '--'
  }
  const value = record[key]
  return typeof value === 'string' && value ? value : '--'
}

function formatGoalLineTag(value: string) {
  const normalized = value.trim()
  if (!normalized) {
    return '[0]'
  }
  return `[${normalized}]`
}

const HAD_OPTION_ORDER = [
  { key: 'h', label: '胜' },
  { key: 'd', label: '平' },
  { key: 'a', label: '负' },
] as const

const TTG_OPTION_ORDER = [
  { key: 's0', label: '0' },
  { key: 's1', label: '1' },
  { key: 's2', label: '2' },
  { key: 's3', label: '3' },
  { key: 's4', label: '4' },
  { key: 's5', label: '5' },
  { key: 's6', label: '6' },
  { key: 's7', label: '7+' },
] as const

const HAFU_OPTION_ORDER = [
  { key: 'hh', label: '胜胜' },
  { key: 'hd', label: '胜平' },
  { key: 'ha', label: '胜负' },
  { key: 'dh', label: '平胜' },
  { key: 'dd', label: '平平' },
  { key: 'da', label: '平负' },
  { key: 'ah', label: '负胜' },
  { key: 'ad', label: '负平' },
  { key: 'aa', label: '负负' },
] as const

const CRS_OPTION_ORDER = [
  { key: 's01s00', label: '1:0' },
  { key: 's02s00', label: '2:0' },
  { key: 's02s01', label: '2:1' },
  { key: 's03s00', label: '3:0' },
  { key: 's03s01', label: '3:1' },
  { key: 's03s02', label: '3:2' },
  { key: 's04s00', label: '4:0' },
  { key: 's04s01', label: '4:1' },
  { key: 's04s02', label: '4:2' },
  { key: 's05s00', label: '5:0' },
  { key: 's05s01', label: '5:1' },
  { key: 's05s02', label: '5:2' },
  { key: 's1sh', label: '胜其它' },
  { key: 's00s00', label: '0:0' },
  { key: 's01s01', label: '1:1' },
  { key: 's02s02', label: '2:2' },
  { key: 's03s03', label: '3:3' },
  { key: 's1sd', label: '平其它' },
  { key: 's00s01', label: '0:1' },
  { key: 's00s02', label: '0:2' },
  { key: 's01s02', label: '1:2' },
  { key: 's00s03', label: '0:3' },
  { key: 's01s03', label: '1:3' },
  { key: 's02s03', label: '2:3' },
  { key: 's00s04', label: '0:4' },
  { key: 's01s04', label: '1:4' },
  { key: 's02s04', label: '2:4' },
  { key: 's00s05', label: '0:5' },
  { key: 's01s05', label: '1:5' },
  { key: 's02s05', label: '2:5' },
  { key: 's1sa', label: '负其它' },
] as const

const CRS_OPTION_GROUPS = [
  {
    key: 'crs-win',
    options: CRS_OPTION_ORDER.slice(0, 13),
  },
  {
    key: 'crs-draw',
    options: CRS_OPTION_ORDER.slice(13, 18),
  },
  {
    key: 'crs-lose',
    options: CRS_OPTION_ORDER.slice(18),
  },
] as const
