import { useState } from 'react'

import { createLotteryBet, type LotteryGameKey } from '../../api/betApi'
import { ApiError } from '../../api/httpClient'
import { useNavigate } from '../../lib/navigation'
import { useAuthStore } from '../../store/authStore'
import './lotteryBet.scss'

/**
 * 号码池彩种（大乐透 / 双色球 / 快乐8）推荐卡的「一键投注」。
 *
 * 只投主推单式：大乐透 5+2、双色球 6+1、快乐8 选十 10 码，1 注 2 元。
 * 复式池（双色球 12+4 等）注数太大，不在这里一键提交，仍可在「选号投注」里手动选。
 */

type Props = {
  game: LotteryGameKey
  main: number[]
  extra?: number[]
  /** 按钮文案里的主推说明，如「主推 6+1」 */
  label: string
}

const UNIT_PRICE = 2

export function LotteryQuickBetButton({ game, main, extra = [], label }: Props) {
  const token = useAuthStore((state) => state.token)
  const ready = useAuthStore((state) => state.ready)
  const navigate = useNavigate()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const valid = main.length > 0
  const buttonLabel = saved
    ? '已保存到我的投注'
    : saving
      ? '投注中…'
      : !token && ready
        ? '登录后一键投注'
        : `一键投注 · ${label}`

  async function submit() {
    if (!ready || saving || saved || !valid) {
      return
    }
    if (!token) {
      navigate('/login', { state: { from: '/history' } })
      return
    }
    setSaving(true)
    setError('')
    try {
      await createLotteryBet(token, {
        kind: 'lottery',
        game,
        numbers: { main: [...main], extra: [...extra] },
        multiple: 1,
      })
      setSaved(true)
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        navigate('/login', { state: { from: '/history' } })
        return
      }
      setError(failure instanceof Error ? failure.message : '保存失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="history-auto-bet lottery-quick">
      <button
        type="button"
        className="history-auto-bet__button"
        onClick={() => void submit()}
        disabled={!ready || saving || saved || !valid}
      >
        {saved ? '已保存到我的投注' : saving ? '投注中…' : buttonLabel}
      </button>
      <span className="history-auto-bet__meta" aria-live="polite">
        {saved ? (
          <button
            type="button"
            className="history-auto-bet__link"
            onClick={() => navigate('/my-bets')}
          >
            去我的投注截图
          </button>
        ) : (
          `1 注 · ${UNIT_PRICE} 元`
        )}
      </span>
      {error && (
        <span className="history-auto-bet__error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
