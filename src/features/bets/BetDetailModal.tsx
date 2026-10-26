import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import html2canvas from 'html2canvas'
import { useNavigate } from 'react-router-dom'

import type { Bet } from '../../api/betApi'
import {
  OUTCOME_LABELS,
  POOL_LABELS,
  STATUS_LABELS,
  formatFullDateTime,
  formatMoney,
} from './format'

type BetDetailModalProps = {
  bet: Bet | null
  open: boolean
  deleting: boolean
  onClose: () => void
  onDelete: (bet: Bet) => void
}

/**
 * 投注单详情弹层。
 *
 * 三个出口：
 *   - 截图：导出一张 PNG，可以直接拿到实体店照着打；
 *   - 去投注：带着这单回填到首页投注栏、切到对应玩法并打开方案弹层；
 *   - 删除。
 */
export function BetDetailModal({ bet, open, deleting, onClose, onDelete }: BetDetailModalProps) {
  const navigate = useNavigate()
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [hint, setHint] = useState('')

  if (!open || !bet || typeof document === 'undefined') {
    return null
  }

  const betId = bet.id

  async function capture() {
    if (!cardRef.current || capturing) {
      return
    }
    setCapturing(true)
    setHint('')
    try {
      if (document.fonts) {
        await document.fonts.ready
      }
      const scale = Math.min(4, Math.max(2, (window.devicePixelRatio || 1) * 2))
      const canvas = await html2canvas(cardRef.current, {
        useCORS: true,
        scale,
        backgroundColor: '#ffffff',
        logging: false,
        // 截图里不要操作按钮和提示条；同时解除高度限制，保证场次全在图上
        onclone: (clonedDocument) => {
          clonedDocument
            .querySelectorAll<HTMLElement>('.bet-modal__foot, .bet-modal__close, .bet-modal__hint')
            .forEach((element) => {
              element.style.display = 'none'
            })
          const card = clonedDocument.querySelector<HTMLElement>('.bet-modal__card')
          if (card) {
            card.style.maxHeight = 'none'
            card.style.height = 'auto'
          }
          const legs = clonedDocument.querySelector<HTMLElement>('.bet-modal__legs')
          if (legs) {
            legs.style.flex = '0 0 auto'
            legs.style.maxHeight = 'none'
            legs.style.overflow = 'visible'
          }
        },
      })

      const link = document.createElement('a')
      link.href = canvas.toDataURL('image/png')
      link.download = `ticai-bet-${betId}.png`
      link.click()
      setHint('截图已生成，可在下载目录查看')
    } catch {
      setHint('截图失败，请重试')
    } finally {
      setCapturing(false)
    }
  }

  function goBet() {
    onClose()
    navigate('/', { state: { applyBet: bet } })
  }

  return createPortal(
    <div
      className="bet-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bet-modal-title"
      onClick={onClose}
    >
      <div className="bet-modal__card" ref={cardRef} onClick={(event) => event.stopPropagation()}>
        <header className="bet-modal__head">
          <div className="bet-modal__title">
            <p className="bet-modal__eyebrow">
              {formatFullDateTime(bet.placedAt)} · {bet.passTypes.join('、')}
            </p>
            <h3 id="bet-modal-title">{bet.title}</h3>
          </div>
          <div className="bet-modal__head-right">
            <span className={`bet-badge bet-badge--${bet.status}`}>{STATUS_LABELS[bet.status]}</span>
            <button type="button" className="bet-modal__close" onClick={onClose} aria-label="关闭">
              ×
            </button>
          </div>
        </header>

        <dl className="bet-modal__meta">
          <div>
            <dt>倍数</dt>
            <dd>{bet.multiple} 倍</dd>
          </div>
          <div>
            <dt>注数</dt>
            <dd>{bet.units} 注</dd>
          </div>
          <div>
            <dt>投注金额</dt>
            <dd>{formatMoney(bet.amount)} 元</dd>
          </div>
          <div>
            <dt>最高奖金</dt>
            <dd>{formatMoney(bet.maxBonus)} 元</dd>
          </div>
          <div>
            <dt>中奖金额</dt>
            <dd className={bet.payout > 0 ? 'is-won' : ''}>{formatMoney(bet.payout)} 元</dd>
          </div>
          <div>
            <dt>过关注数</dt>
            <dd>
              {bet.passTypeDetails.length > 0
                ? bet.passTypeDetails.map((detail) => `${detail.passType} ${detail.wonUnits}/${detail.totalUnits}`).join(' · ')
                : '—'}
            </dd>
          </div>
        </dl>

        <ul className="bet-modal__legs">
          {bet.legs.map((leg) => (
            <li key={leg.id} className="bet-modal__leg">
              <div className="bet-modal__leg-main">
                <p className="bet-modal__match">
                  <span className="bet-modal__no">{leg.matchNo}</span>
                  {leg.homeName} vs {leg.awayName}
                </p>
                <p className="bet-modal__pick">
                  {POOL_LABELS[leg.pool]} · {leg.optionLabel}
                  <span className="bet-modal__odds">@{leg.odds.toFixed(2)}</span>
                </p>
                {leg.kickoffAt && <p className="bet-modal__time">开赛 {formatFullDateTime(leg.kickoffAt)}</p>}
              </div>
              <div className="bet-modal__leg-side">
                {leg.result?.settled && leg.result.homeScore !== null && leg.result.awayScore !== null && (
                  <span className="bet-modal__score">
                    {leg.result.homeScore}:{leg.result.awayScore}
                  </span>
                )}
                <span className={`bet-leg__result bet-leg__result--${leg.outcome}`}>
                  {OUTCOME_LABELS[leg.outcome]}
                </span>
              </div>
            </li>
          ))}
        </ul>

        {hint && <p className="bet-modal__hint">{hint}</p>}

        <footer className="bet-modal__foot">
          <button
            type="button"
            className="btn-ghost bet-modal__delete"
            disabled={deleting || capturing}
            onClick={() => onDelete(bet)}
          >
            {deleting ? '删除中…' : '删除'}
          </button>
          <button
            type="button"
            className="btn-ghost bet-modal__shot"
            disabled={capturing}
            onClick={() => void capture()}
          >
            {capturing ? '生成中…' : '截图'}
          </button>
          <button type="button" className="btn-primary bet-modal__go" onClick={goBet}>
            去投注
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
