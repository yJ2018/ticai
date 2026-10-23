import { useCallback, useRef, useState } from 'react'

import { type MatchCard, type MatchPoolType } from '../../service/matchService'
import {
  assembleAnalysis,
  buildParlayPlan,
  fitLambdas,
  modelProbabilities,
  readMarketEntries,
  shortenPlan,
  type LambdaFit,
  type MarketEntry,
  type MatchAnalysis,
  type ParlayPlan,
} from './parlayModel'

export type AutoStepStatus = 'pending' | 'active' | 'done'

export type AutoStep = {
  key: string
  label: string
  detail: string
  status: AutoStepStatus
}

export type AutoParlayState = {
  poolType: MatchPoolType | null
  running: boolean
  steps: AutoStep[]
  processed: number
  total: number
  plan: ParlayPlan | null
  /** 负期望时给出的短串替代（3串1） */
  shortPlan: ParlayPlan | null
  error: string
  /** 每场三选的数量，用于结果页的一句话说明 */
  analyzed: number
}

const STEP_DEFS: Array<{ key: string; label: string }> = [
  { key: 'odds', label: '读取在售赔率' },
  { key: 'market', label: '去水算市场概率' },
  { key: 'lambda', label: '拟合预期进球 λ' },
  { key: 'model', label: '泊松模型推选项概率' },
  { key: 'ev', label: '计算 EV 与置信度' },
  { key: 'plan', label: '生成三选与串关' },
]

const INITIAL: AutoParlayState = {
  poolType: null,
  running: false,
  steps: STEP_DEFS.map((step) => ({ ...step, status: 'pending', detail: '' })),
  processed: 0,
  total: 0,
  plan: null,
  shortPlan: null,
  error: '',
  analyzed: 0,
}

type WorkItem = {
  card: MatchCard
  entries: MarketEntry[]
  fit: LambdaFit | null
  probabilities: Map<string, number> | null
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

/**
 * 一键串关的分析流程：每一步都真的算，只是分批 + 小延时把过程露出来。
 * 步骤顺序对齐 skill：赔率 → 去水 → λ → 泊松 → EV → 三选 → 串关。
 */
export function useAutoParlay() {
  const [state, setState] = useState<AutoParlayState>(INITIAL)
  const runToken = useRef(0)

  const patchStep = useCallback((key: string, patch: Partial<AutoStep>) => {
    setState((prev) => ({
      ...prev,
      steps: prev.steps.map((step) => (step.key === key ? { ...step, ...patch } : step)),
    }))
  }, [])

  const close = useCallback(() => {
    runToken.current += 1
    setState(INITIAL)
  }, [])

  const start = useCallback(
    async (cards: MatchCard[], poolType: MatchPoolType) => {
      const token = runToken.current + 1
      runToken.current = token
      const alive = () => runToken.current === token

      setState({ ...INITIAL, poolType, running: true, total: cards.length })
      patchStep('odds', { status: 'active', detail: `${cards.length} 场在售` })
      await sleep(260)
      if (!alive()) {
        return
      }
      patchStep('odds', { status: 'done', detail: `${cards.length} 场在售` })

      const work: WorkItem[] = cards.map((card) => ({
        card,
        entries: [],
        fit: null,
        probabilities: null,
      }))

      /* ── 去水 ── */
      patchStep('market', { status: 'active' })
      let processed = 0
      for (let index = 0; index < work.length; index += 10) {
        for (const item of work.slice(index, index + 10)) {
          item.entries = readMarketEntries(item.card, poolType)
        }
        processed = Math.min(index + 10, work.length)
        setState((prev) => ({ ...prev, processed }))
        await sleep(70)
        if (!alive()) {
          return
        }
      }
      const withMarket = work.filter((item) => item.entries.length > 0).length
      patchStep('market', { status: 'done', detail: `${withMarket} 场有完整赔率` })

      /* ── 拟合 λ ── */
      patchStep('lambda', { status: 'active' })
      for (let index = 0; index < work.length; index += 10) {
        for (const item of work.slice(index, index + 10)) {
          item.fit = fitLambdas(item.card.markets)
        }
        setState((prev) => ({ ...prev, processed: Math.min(index + 10, work.length) }))
        await sleep(70)
        if (!alive()) {
          return
        }
      }
      const fromOneXTwo = work.filter((item) => item.fit?.source === '1x2').length
      const fromTtg = work.filter((item) => item.fit?.source === 'ttg').length
      patchStep('lambda', {
        status: 'done',
        detail: fromTtg > 0 ? `${fromOneXTwo} 场用 1X2，${fromTtg} 场用总进球兜底` : `${fromOneXTwo} 场用 1X2`,
      })

      /* ── 泊松推概率 ── */
      patchStep('model', { status: 'active' })
      for (let index = 0; index < work.length; index += 8) {
        for (const item of work.slice(index, index + 8)) {
          if (item.fit) {
            item.probabilities = modelProbabilities(item.fit, item.card.markets)
          }
        }
        setState((prev) => ({ ...prev, processed: Math.min(index + 8, work.length) }))
        await sleep(60)
        if (!alive()) {
          return
        }
      }
      const withModel = work.filter((item) => item.probabilities).length
      patchStep('model', { status: 'done', detail: `${withModel} 场完成推演` })

      /* ── 三选 + 置信度 ── */
      patchStep('ev', { status: 'active' })
      const analyses: MatchAnalysis[] = []
      for (let index = 0; index < work.length; index += 6) {
        for (const item of work.slice(index, index + 6)) {
          if (!item.fit || !item.probabilities) {
            continue
          }
          const analysis = assembleAnalysis(
            item.card,
            poolType,
            item.entries,
            item.fit,
            item.probabilities,
          )
          if (analysis) {
            analyses.push(analysis)
          }
        }
        setState((prev) => ({ ...prev, processed: Math.min(index + 6, work.length) }))
        await sleep(50)
        if (!alive()) {
          return
        }
      }
      patchStep('ev', { status: 'done', detail: `${analyses.length} 场给出候选` })

      /* ── 组串 ── */
      patchStep('plan', { status: 'active' })
      await sleep(320)
      if (!alive()) {
        return
      }

      const plan = buildParlayPlan(analyses, poolType)
      const shortPlan =
        plan && plan.expectedReturn < 1 && plan.legs.length > 3 ? shortenPlan(plan, 3) : null

      patchStep('plan', {
        status: 'done',
        detail: plan ? `${plan.legs.length} 场 · ${plan.legs.length}串1` : '可用场次不足',
      })

      setState((prev) => ({
        ...prev,
        running: false,
        plan,
        shortPlan,
        error: plan ? '' : '可用赔率不足，无法生成串关',
        total: analyses.length,
        processed: analyses.length,
        analyzed: analyses.length,
      }))
    },
    [patchStep],
  )

  return { state, start, close }
}
