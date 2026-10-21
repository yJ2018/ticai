import { type AiMessage } from '../../api/aiApi'
import { type VenueWeatherResult } from '../../api/venueWeatherApi'
import { type MatchCard, type MatchPoolType } from '../../service/matchService'

export const POOL_LABELS: Record<MatchPoolType, string> = {
  had: '胜平负',
  crs: '比分',
  ttg: '总进球数',
  hafu: '半全场',
  mixed: '混合过关',
}

const POOL_FOCUS: Record<MatchPoolType, string> = {
  had: '重点给出胜/平/负推荐，并结合让球盘口说明是否值得考虑让球选项',
  crs: '重点给出最可能的 2-3 个比分，按概率从高到低排列',
  ttg: '重点给出总进球数区间（如 0-1 球 / 2-3 球 / 4 球以上），并给出最可能的具体进球数',
  hafu: '重点给出半全场组合推荐，并说明对上半场走势的判断',
  mixed: '从胜平负、总进球、比分、半全场中挑出 1-2 个最有价值的选项，不要面面俱到',
}

const SYSTEM_PROMPT = `你是一名资深足球比赛分析师，服务中国竞彩用户。你会收到一场比赛的赛程、当前玩法、赔率参考，以及比赛地天气（可能来自预报，也可能缺失）。

请严格按以下维度分析：
1. 双方近期状态与战术风格；
2. 阵容与伤停：只写你有把握的信息；无法确认时必须明确写“暂无可靠信息”，严禁编造球员姓名、伤情或首发名单；
3. 主客场、赛程密度与旅途因素；
4. 天气：如果提供了比赛地天气，分析温度/降雨/风力对比赛节奏的影响；如果缺失，直接说明天气信息缺失，不要编造；天气来自预报时请注明“预报”；
5. 赔率：结合当前玩法解读市场倾向，但不要声称有内幕消息。

输出格式（严格遵守，不要使用 Markdown 表格、不要输出 JSON）：
【分析】
1. 状态与风格：...
2. 阵容与伤停：...
3. 主客场与赛程：...
4. 天气影响：...
5. 赔率解读：...
【预测】
推荐选项：...
比分参考：...
信心等级：高/中/低
理由：一句话总结
以上为 AI 分析，仅供参考，不构成投注建议。

要求：中文，总字数 600-800 字，结论明确，不要模棱两可。`

export type MatchAnalysisInput = {
  match: MatchCard
  pool: MatchPoolType
  venueWeather?: VenueWeatherResult | null
}

export function buildMatchAnalysisMessages({
  match,
  pool,
  venueWeather,
}: MatchAnalysisInput): AiMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildMatchPrompt(match, pool, venueWeather) },
  ]
}

function buildMatchPrompt(
  match: MatchCard,
  pool: MatchPoolType,
  venueWeather?: VenueWeatherResult | null,
) {
  const teams = `${match.homeTeam ?? '主队'} vs ${match.awayTeam ?? '客队'}`
  const kickoff = match.time || '未知时间'
  const odds = formatOddsForPrompt(match, pool).slice(0, 900)

  return [
    `比赛：${match.matchNo ? `${match.matchNo} ` : ''}${match.subtitle || '未知赛事'} ${teams}`,
    `开赛时间：${kickoff}（北京时间）`,
    `当前玩法：${POOL_LABELS[pool]}（${POOL_FOCUS[pool]}）`,
    `赔率参考：${odds}`,
    `比赛地天气：${formatVenueWeather(venueWeather)}`,
    '',
    '请按系统提示的格式输出这场比赛的分析与预测。',
  ].join('\n')
}

/**
 * 把当前玩法的完整赔率拼成一段文本。只给 AI 摘要会丢掉大部分比分/半全场选项，
 * 因此优先使用 optionGroups 里的全部可选项，超长时再截断。
 */
export function formatOddsForPrompt(match: MatchCard, pool: MatchPoolType) {
  const groups =
    pool === 'mixed'
      ? [
          ...(match.optionGroups ?? []),
          ...(match.mixedSections ?? []).flatMap((section) => section.groups),
        ]
      : (match.optionGroups ?? [])

  const parts: string[] = []

  for (const group of groups) {
    const options = group.options
      .filter((option) => option.value && option.value !== '--')
      .map((option) => `${option.label}:${option.value}`)

    if (options.length === 0) {
      continue
    }

    parts.push(`${group.rowLabel ? `${group.rowLabel} ` : ''}${options.join(' / ')}`)
  }

  return parts.join('；') || match.oddsSummary || '暂无'
}

function formatVenueWeather(weather?: VenueWeatherResult | null) {
  if (!weather) {
    return '未获取到比赛地天气，请不要编造，直接说明天气信息缺失'
  }

  if (!weather.available) {
    return `未获取到比赛地天气（${weather.reason}），请不要编造，直接说明天气信息缺失`
  }

  const parts = [`比赛地 ${weather.city}（${weather.country}）`]
  const { current, kickoff, daily } = weather

  if (current) {
    const details = [
      current.temperature !== null ? `当前 ${current.temperature}℃` : '当前温度未知',
      current.weather,
      current.humidity !== null ? `湿度 ${current.humidity}%` : '',
      current.windSpeed !== null ? `风速 ${current.windSpeed}m/s` : '',
    ].filter(Boolean)

    parts.push(details.join('，'))
  }

  if (kickoff && kickoff.temperature !== null) {
    const time = kickoff.time.replace('T', ' ')
    const precipitation =
      kickoff.precipitationProbability !== null
        ? `，降水概率 ${kickoff.precipitationProbability}%`
        : ''
    parts.push(
      `开赛时段（当地 ${time}）${kickoff.temperature}℃，${kickoff.weather}${precipitation}`,
    )
  }

  const day = daily?.[0]
  if (day && day.tempMin !== null && day.tempMax !== null) {
    const precipitation =
      day.precipitationProbability !== null
        ? `，降水概率 ${day.precipitationProbability}%`
        : ''
    parts.push(`当日 ${day.tempMin}~${day.tempMax}℃，${day.weather}${precipitation}`)
  }

  parts.push('（Open-Meteo 预报）')
  return parts.join('；')
}

export type AnalysisSummary = {
  recommendation: string
  confidence: string
  score: string
}

/**
 * 从模型输出里提取「推荐 / 信心 / 比分」，失败时返回 null。
 * 模型偶尔会用 Markdown 加粗，这里先做一次轻量清洗。
 */
export function parseAnalysisSummary(content: string): AnalysisSummary | null {
  if (!content) {
    return null
  }

  const normalized = content.replace(/\*\*/g, '').replace(/^#{1,6}\s*/gm, '')
  const recommendation = normalized.match(/推荐选项[：:]\s*([^\n]+)/)?.[1]?.trim() ?? ''
  const confidence = normalized.match(/信心等级[：:]\s*(高|中|低)/)?.[1] ?? ''
  const score = normalized.match(/比分参考[：:]\s*([^\n]+)/)?.[1]?.trim() ?? ''

  if (!recommendation && !confidence) {
    return null
  }

  return { recommendation, confidence, score }
}
