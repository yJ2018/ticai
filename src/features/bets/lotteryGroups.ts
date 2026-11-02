import type { Bet, LotteryBetInfo } from '../../api/betApi'
import {
  formatMonthDay,
  getLotteryDrawRuleLabel,
  getNextLotteryDrawDate,
} from '../../domain/lotterySchedule'

/**
 * 「我的投注」列表的展示分组。
 *
 * 同彩种、同状态、同开奖批次的彩票单合成一张卡：
 *   - 已开奖：同一期号（`draw.issue`）；
 *   - 待开奖：按彩种开奖日估算的同一个目标开奖日（21:00 截止）。
 *
 * 即使同批次的票在列表里被其它彩票单隔开，也归到同一张合并卡（仍然各自按时间排序）；
 * 足球单不参与合并。分组只影响展示，统计 / 删除仍以单张 `bet` 为单位。
 */

export type LotteryGroup = {
  key: string
  gameKey: string
  gameName: string
  status: Bet['status']
  bets: Bet[]
  draw: LotteryBetInfo['draw']
  /** 已开奖用真实期号；待开奖用预计开奖日 */
  periodKey: string
  periodLabel: string
  periodHint: string
  pendingTargetDate: string | null
  totalUnits: number
  totalAmount: number
  latestPlacedAt: string
  multiples: number[]
}

export type BetListEntry =
  | { kind: 'bet'; bet: Bet }
  | { kind: 'lottery'; group: LotteryGroup }

export function buildBetListEntries(items: Bet[]): BetListEntry[] {
  const entries: BetListEntry[] = []
  const groups = new Map<string, LotteryGroup>()

  for (const bet of items) {
    const lottery = bet.lottery
    if (bet.kind !== 'lottery' || !lottery) {
      entries.push({ kind: 'bet', bet })
      continue
    }

    const period = resolveLotteryPeriod(bet, lottery)
    const key = `${lottery.gameKey}|${bet.status}|${period.periodKey}`
    const existing = groups.get(key)
    if (existing) {
      appendToGroup(existing, bet)
      continue
    }

    const group: LotteryGroup = {
      key,
      gameKey: lottery.gameKey,
      gameName: lottery.name,
      status: bet.status,
      bets: [bet],
      draw: period.draw,
      periodKey: period.periodKey,
      periodLabel: period.periodLabel,
      periodHint: period.periodHint,
      pendingTargetDate: period.pendingTargetDate,
      totalUnits: bet.units,
      totalAmount: bet.amount,
      latestPlacedAt: bet.placedAt,
      multiples: [bet.multiple],
    }
    groups.set(key, group)
    entries.push({ kind: 'lottery', group })
  }

  return entries
}

function resolveLotteryPeriod(bet: Bet, lottery: LotteryBetInfo) {
  if (lottery.draw) {
    return {
      draw: lottery.draw,
      periodKey: `issue:${lottery.draw.issue}`,
      periodLabel: `第 ${lottery.draw.issue} 期`,
      periodHint: `${lottery.draw.drawDate} 开奖`,
      pendingTargetDate: null,
    }
  }

  const targetDate = getNextLotteryDrawDate(lottery.gameKey, bet.placedAt)
  return {
    draw: null,
    periodKey: `target:${targetDate}`,
    periodLabel: `预计 ${formatMonthDay(targetDate)} 开奖`,
    periodHint: getLotteryDrawRuleLabel(lottery.gameKey),
    pendingTargetDate: targetDate,
  }
}

function appendToGroup(group: LotteryGroup, bet: Bet) {
  group.bets.push(bet)
  group.totalUnits += bet.units
  group.totalAmount = Number((group.totalAmount + bet.amount).toFixed(2))
  if (!group.multiples.includes(bet.multiple)) {
    group.multiples.push(bet.multiple)
  }
}
