import { type AiMessage } from '../../api/aiApi'
import { type MatchCard, type MatchPoolType } from '../../service/matchService'
import { formatOddsForPrompt, POOL_LABELS } from './aiAnalysis'
import { formatMoney, type PlanEntry } from './betSlipMath'

const PARLAY_SYSTEM_PROMPT = `你是一名资深竞彩足球分析师，服务中国竞彩用户。用户会给你一个已经选好的串关方案，包含每一场的对阵、当前选择和市场赔率。你的任务不是泛泛预测所有比赛，而是逐场审视用户已经选中的选项，并判断这些比赛串在一起后的整体风险。

请遵守：
1. 只分析用户给出的比赛，不要新增未列出的比赛；
2. 逐场结合双方实力、近期状态、主客场、赛程与战意，判断已选选项是否成立。无法确认的伤停、首发或球员信息必须写“暂无可靠信息”，严禁编造；
3. 赔率只作为市场参考，可以解读隐含概率和热度，但不要声称有内幕消息；
4. 指出串关的关联风险、同质风险和关键短板，例如多场都押大球、都押热门、开赛时间集中等；
5. 可以给出保留、谨慎或调整方向的倾向，但不得承诺收益，不得建议加注金额；
6. 如果总场次较多，逐场分析可以更简短，但每一场都必须覆盖。

输出格式（严格遵守，不要使用 Markdown 表格、不要输出 JSON）：
【总评】
方案思路：...
整体风险：低/中/高
【逐场分析】
1. 场次与选择：...
判断：...
风险：...
建议：...
（按此格式覆盖方案里的每一场，序号与用户给出的场次序号一致）
【串关建议】
关联风险：...
关键短板：...
可调整方向：...
【结论】
综合信心：高/中/低
一句话总结：...
以上为 AI 分析，仅供参考，不构成投注建议。

要求：中文，直接围绕这个串关方案，总字数 650-950 字（5 场以上可到 1100 字），结论明确，不要模棱两可。`

export type ParlayAnalysisInput = {
  pool: MatchPoolType
  passSummaryText: string
  entries: PlanEntry[]
  matches: MatchCard[]
  betAmount: number
  maxBonus: number
}

export function buildParlayAnalysisMessages(input: ParlayAnalysisInput): AiMessage[] {
  return [
    { role: 'system', content: PARLAY_SYSTEM_PROMPT },
    { role: 'user', content: buildParlayPrompt(input) },
  ]
}

export function buildParlayAnalysisKey(input: ParlayAnalysisInput) {
  const legs = input.entries.map((entry) => {
    const options = entry.selectedOptions
      .map((option) => `${option.key}:${option.value}`)
      .join(',')
    return `${entry.id}[${options}]`
  })

  return `${input.pool}:${input.passSummaryText}:${legs.join('|')}`
}

function buildParlayPrompt(input: ParlayAnalysisInput) {
  const matchById = new Map(input.matches.map((match) => [match.id, match]))
  const legBlocks = input.entries.map((entry) => formatLegForPrompt(entry, matchById, input.pool))

  return [
    `方案概况：${input.passSummaryText || '未选择过关方式'}，共 ${input.entries.length} 场，投注金额 ${formatMoney(
      input.betAmount,
    )} 元，理论最高奖金 ${formatMoney(input.maxBonus)} 元。`,
    `当前玩法：${POOL_LABELS[input.pool]}。`,
    '',
    ...legBlocks,
    '请只基于以上已选比赛逐场分析，并评估这个串关方案的整体风险。',
  ].join('\n\n')
}

function formatLegForPrompt(
  entry: PlanEntry,
  matchById: Map<number, MatchCard>,
  pool: MatchPoolType,
) {
  const match = matchById.get(entry.id)
  const league = match?.subtitle || '未知赛事'
  const selected = entry.selectedOptions
    .map((option) => {
      const oddText = option.value ? `（赔率 ${option.value}）` : ''
      return `${option.label}${oddText}`
    })
    .join('、')
  const marketOdds = match ? formatOddsForPrompt(match, pool) : ''
  const trimmedOdds =
    marketOdds.length > 1_200 ? `${marketOdds.slice(0, 1_200)}…` : marketOdds

  return [
    `第${entry.order}场｜${entry.matchNo} ${entry.teams}`,
    `联赛与开赛：${league}｜${entry.kickoffTime}`,
    `当前选择：${selected || '未选择'}`,
    `市场赔率参考：${trimmedOdds || '暂无'}`,
  ].join('\n')
}

export type ParlayAnalysisSummary = {
  risk: string
  confidence: string
  verdict: string
}

/** 从串关分析输出里提取整体风险、综合信心和一句话总结。 */
export function parseParlaySummary(content: string): ParlayAnalysisSummary | null {
  if (!content) {
    return null
  }

  const normalized = content.replace(/\*\*/g, '').replace(/^#{1,6}\s*/gm, '')
  const risk = normalized.match(/整体风险[：:]\s*(低|中|高)/)?.[1] ?? ''
  const confidence = normalized.match(/综合信心[：:]\s*(高|中|低)/)?.[1] ?? ''
  const verdict = normalized.match(/一句话总结[：:]\s*([^\n]+)/)?.[1]?.trim() ?? ''

  if (!risk && !confidence) {
    return null
  }

  return { risk, confidence, verdict }
}
