import type { Bet, MarketPool } from '../../api/betApi'

/** 我的投注 / 投注详情共用的文案与格式化，避免两处各写一份。 */

export const POOL_LABELS: Record<MarketPool, string> = {
  had: '胜平负',
  hhad: '让球胜平负',
  ttg: '总进球',
  crs: '比分',
  hafu: '半全场',
}

export const POOL_FILTER_OPTIONS: Array<{ value: MarketPool | ''; label: string }> = [
  { value: '', label: '全部玩法' },
  { value: 'had', label: '胜平负' },
  { value: 'hhad', label: '让球' },
  { value: 'ttg', label: '总进球' },
  { value: 'crs', label: '比分' },
  { value: 'hafu', label: '半全场' },
]

export const STATUS_LABELS: Record<Bet['status'], string> = {
  pending: '待开奖',
  won: '中奖',
  lost: '未中',
}

export const OUTCOME_LABELS: Record<'won' | 'lost' | 'pending', string> = {
  won: '中',
  lost: '未中',
  pending: '待开奖',
}

export function formatMoney(value: number) {
  if (!Number.isFinite(value)) {
    return '0.00'
  }
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 赔率变化 = 开奖赔率 - 票面赔率；缺开奖赔率返回 null。 */
export function oddsDelta(closingOdds: number | null | undefined, odds: number) {
  if (closingOdds === null || closingOdds === undefined || !Number.isFinite(closingOdds)) {
    return null
  }
  const delta = Number((closingOdds - odds).toFixed(2))
  return Math.abs(delta) < 0.005 ? 0 : delta
}

/** +0.16 / -0.05；0 返回空串（表示持平，不占位）。 */
export function formatDelta(delta: number | null | undefined) {
  if (delta === null || delta === undefined || delta === 0) {
    return ''
  }
  return `${delta > 0 ? '+' : ''}${delta.toFixed(2)}`
}

/** 开奖赔率的说明文案：哪来的、什么时候的快照。 */
export function describeClosingOdds(pending: boolean, capturedAt: string | null) {
  const label = pending ? '最新赔率' : '开奖赔率'
  const at = capturedAt ? `（${formatDateTime(capturedAt)} 快照）` : ''
  return `${label}：停售前最后一份官方赔率${at}`
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

/** 本地时区的 MM-DD HH:mm */
export function formatDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '—'
  }
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 本地时区的 MM-DD HH:mm（带年份判断，详情弹层用） */
export function formatFullDateTime(value: string | null) {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '—'
  }
  return date.toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
