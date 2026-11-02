import { useRef, useState } from 'react'

import type { Bet, LotteryBetInfo } from '../../api/betApi'
import { STATUS_LABELS, formatDateTime, formatMoney } from './format'
import type { LotteryGroup } from './lotteryGroups'

/**
 * 同类同期的合并投注卡。
 *
 * 多张 1 注 2 元的排列五 / 大乐透不再各占一张卡：
 * 同一个开奖批次合成一张，号码逐张列出，合计注数/金额放页脚；
 * 右上角「截图」把整张合并卡导出为 PNG（按钮本身不进图）。
 */

type LotteryBetGroupProps = {
  group: LotteryGroup
  deleting: boolean
  onDelete: (group: LotteryGroup) => void
  onSnapshot: (dataUrl: string, fileName: string) => void
}

export function LotteryBetGroup({
  group,
  deleting,
  onDelete,
  onSnapshot,
}: LotteryBetGroupProps) {
  const captureRef = useRef<HTMLElement | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [captureError, setCaptureError] = useState('')

  const pending = !group.draw
  const multipleText =
    group.multiples.length === 1
      ? `${group.multiples[0]} 倍`
      : `倍数 ${group.multiples.join(' / ')}`

  async function capture() {
    const target = captureRef.current
    if (!target || capturing) {
      return
    }

    setCapturing(true)
    setCaptureError('')
    try {
      if (typeof document !== 'undefined' && document.fonts) {
        await document.fonts.ready
      }
      const { default: html2canvas } = await import('html2canvas')
      const scale = Math.min(3, Math.max(2, (window.devicePixelRatio || 1) * 2))
      const captureWidth = Math.max(
        320,
        Math.min(680, Math.round(target.getBoundingClientRect().width) || 680),
      )
      const canvas = await html2canvas(target, {
        useCORS: true,
        scale,
        backgroundColor: '#ffffff',
        logging: false,
        onclone: (clonedDocument) => {
          // 截图按钮 / 删除按钮 / 错误提示都不进图；合计金额和落款保留
          clonedDocument
            .querySelectorAll<HTMLElement>('.lottery-group__buttons, .lottery-group__error')
            .forEach((element) => {
              element.style.display = 'none'
            })
          const foot = clonedDocument.querySelector<HTMLElement>('.lottery-group__snapshot-foot')
          if (foot) {
            foot.style.display = 'block'
          }
          const card = clonedDocument.querySelector<HTMLElement>('.lottery-group')
          if (card) {
            card.style.boxShadow = 'none'
            // 截图不比页面宽度：桌面收窄到 680px，手机上按原卡宽，避免右侧一大片空白
            card.style.width = `${captureWidth}px`
            card.style.maxWidth = `${captureWidth}px`
          }
        },
      })
      const dataUrl = canvas.toDataURL('image/png')
      const period = group.periodLabel.replace(/[^\d]/g, '') || '合并'
      onSnapshot(dataUrl, `投注-${group.gameName}-${period}.png`)
    } catch {
      setCaptureError('截图失败，请重试')
    } finally {
      setCapturing(false)
    }
  }

  return (
    <article
      ref={captureRef}
      className={`bet-card bet-card--lottery bet-card--${group.status} lottery-group`}
    >
      <header className="bet-card__head">
        <div className="bet-card__title">
          <p className="lottery-group__eyebrow">
            {group.gameName}
            {group.bets.length > 1 && (
              <span className="lottery-group__merged">合并 {group.bets.length} 张</span>
            )}
          </p>
          <h3>{group.periodLabel}</h3>
          <p className="bet-card__meta">
            <span>最近投注 {formatDateTime(group.latestPlacedAt)}</span>
            <span>共 {group.totalUnits} 注</span>
            <span>{formatMoney(group.totalAmount)} 元</span>
            <span>{multipleText}</span>
            <span>{group.periodHint}</span>
          </p>
        </div>
        <span className={`bet-badge bet-badge--${group.status}`}>{STATUS_LABELS[group.status]}</span>
      </header>

      {group.draw && (
        <div className="lottery-bet__draw lottery-group__draw">
          <span>开奖号码</span>
          <LotteryBalls main={group.draw.main} extra={group.draw.extra} />
        </div>
      )}

      {pending && (
        <p className="lottery-group__pending">
          待开奖 · 开奖后按官方号码自动判定（奖金以官方公告为准）
        </p>
      )}

      <ul className="lottery-group__tickets">
        {group.bets.map((bet, index) => {
          const lottery = bet.lottery
          if (!lottery) {
            return null
          }
          const nested =
            Array.isArray(lottery.numbers.main) &&
            Array.isArray((lottery.numbers.main as number[][])[0])
          const drawn = lottery.draw
          return (
            <li key={bet.id} className="lottery-group__ticket">
              <span className="lottery-group__index" aria-hidden="true">
                {index + 1}
              </span>
              <div className="lottery-group__ticket-main">
                {nested ? (
                  <LotteryGroups
                    groups={lottery.numbers.main as number[][]}
                    matched={drawn ? lottery.matchedMain : undefined}
                  />
                ) : (
                  <LotteryBalls
                    main={lottery.numbers.main as number[]}
                    extra={lottery.numbers.extra}
                    matched={drawn ? lottery.matchedMain : undefined}
                  />
                )}
              </div>
              <p className="lottery-group__ticket-meta">
                <span>{formatDateTime(bet.placedAt)}</span>
                <span>{bet.multiple} 倍</span>
                <span>{bet.units} 注</span>
                <span>{formatMoney(bet.amount)} 元</span>
                {drawn && <TicketResult bet={bet} lottery={lottery} />}
                {bet.note && <span>{bet.note}</span>}
              </p>
            </li>
          )
        })}
      </ul>

      <footer className="lottery-group__actions">
        <span className="lottery-group__total">
          合计 {group.totalUnits} 注 · {formatMoney(group.totalAmount)} 元
        </span>
        <div className="lottery-group__buttons">
          <button
            type="button"
            className="lottery-group__capture"
            disabled={capturing}
            onClick={() => void capture()}
          >
            {capturing ? '生成中…' : '截图'}
          </button>
          <button
            type="button"
            className="bet-card__delete"
            disabled={deleting}
            onClick={() => onDelete(group)}
          >
            {deleting ? '删除中…' : '删除'}
          </button>
        </div>
      </footer>

      {captureError && <p className="lottery-group__error">{captureError}</p>}
      <p className="lottery-group__snapshot-foot">体彩助手 · 我的投注 · 仅作娱乐参考</p>
    </article>
  )
}

function TicketResult({ bet, lottery }: { bet: Bet; lottery: LotteryBetInfo }) {
  const nested =
    Array.isArray(lottery.numbers.main) &&
    Array.isArray((lottery.numbers.main as number[][])[0])
  const mainCount = nested
    ? (lottery.numbers.main as number[][]).length
    : (lottery.numbers.main as number[]).length
  const hitText = lottery.positional
    ? `命中 ${lottery.hits.main}/${mainCount} 位`
    : `命中 前区 ${lottery.hits.main}/${mainCount} · 后区 ${lottery.hits.extra}/${lottery.numbers.extra.length}`
  const tierText = lottery.tiers.map((item) => `${item.tier} ${item.units} 注`).join(' / ')

  if (bet.status === 'won') {
    return (
      <>
        <em className="is-won">
          中奖 {lottery.winningUnits} 注{tierText ? `：${tierText}` : ''}
        </em>
        <span>{hitText}</span>
      </>
    )
  }
  if (bet.status === 'lost') {
    return (
      <>
        <em className="is-lost">未中奖</em>
        <span>{hitText}</span>
      </>
    )
  }
  return <span>{hitText}</span>
}

function pad2(value: number) {
  return String(value).padStart(2, '0')
}

function LotteryBalls({
  main,
  extra,
  matched,
}: {
  main: number[]
  extra: number[]
  matched?: boolean[]
}) {
  return (
    <p className="lottery-bet__balls">
      {main.map((value, index) => (
        <span
          key={`main-${index}`}
          className={`lottery-bet__ball${matched?.[index] ? ' is-hit' : ''}`}
        >
          {pad2(value)}
        </span>
      ))}
      {extra.length > 0 && <span className="lottery-bet__plus">+</span>}
      {extra.map((value, index) => (
        <span key={`extra-${index}`} className="lottery-bet__ball is-back">
          {pad2(value)}
        </span>
      ))}
    </p>
  )
}

/** 复式：按位次分组渲染（每位多选），命中位次标绿。 */
function LotteryGroups({ groups, matched }: { groups: number[][]; matched?: boolean[] }) {
  return (
    <p className="lottery-bet__balls is-groups">
      {groups.map((digits, index) => (
        <span className="lottery-bet__group" key={`group-${index}`}>
          {digits.map((value) => (
            <span
              key={`${index}-${value}`}
              className={`lottery-bet__ball${matched?.[index] ? ' is-hit' : ''}`}
            >
              {value}
            </span>
          ))}
          {index < groups.length - 1 && <span className="lottery-bet__plus">|</span>}
        </span>
      ))}
    </p>
  )
}
