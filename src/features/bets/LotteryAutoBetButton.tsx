import { useEffect, useMemo, useRef, useState } from 'react'

import { createLotteryBet, type LotteryGameKey } from '../../api/betApi'
import { ApiError } from '../../api/httpClient'
import { LOTTERY_GAME_META, splitPositionalCombination } from '../../domain/lotteryMeta'
import { useNavigate } from '../../lib/navigation'
import { useAuthStore } from '../../store/authStore'
import './lotteryBet.scss'

/**
 * 「组合参考」的一键加注。
 *
 * 组合参考是各位置候选拼出来的单式串（排列五 `72097`、七星彩 `1234567`），一注 2 元。
 * 点一次就把当前展示的每一组各保存一张单式票；没成功的组会留在按钮上（`补加 N 注`），
 * 已经成功的组记在本地不再重复提交——连点、断网重试都不会重复投注。
 */

type Combination = { value: string; score: number }

type Props = {
  game: LotteryGameKey
  combinations: Combination[]
}

const UNIT_PRICE = 2

type Row = { value: string; digits: number[] }

export function LotteryAutoBetButton({ game, combinations }: Props) {
  const meta = LOTTERY_GAME_META[game]
  const token = useAuthStore((state) => state.token)
  const ready = useAuthStore((state) => state.ready)
  const navigate = useNavigate()

  const [savedValues, setSavedValues] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const lockRef = useRef(false)

  // 组合参考里能拆成合法号码的那些（拆不出来的直接不参与加注）
  const rows = useMemo<Row[]>(() => {
    const result: Row[] = []
    for (const item of combinations) {
      const digits = splitPositionalCombination(item.value, meta.positionMax)
      if (digits) {
        result.push({ value: item.value, digits })
      }
    }
    return result
  }, [combinations, meta.positionMax])

  /** 组合换了（翻页 / 换彩种 / 新快照）就清零，别把上一组当成已加注 */
  const signature = `${game}:${rows.map((row) => row.value).join('|')}`

  useEffect(() => {
    setSavedValues([])
    setError('')
  }, [signature])

  const pending = useMemo(
    () => rows.filter((row) => !savedValues.includes(row.value)),
    [rows, savedValues],
  )
  const total = rows.length
  const done = total > 0 && pending.length === 0
  const amount = pending.length * UNIT_PRICE

  async function handleClick() {
    if (!ready || saving || lockRef.current) {
      return
    }
    if (!token) {
      navigate('/login', { state: { from: '/history' } })
      return
    }
    if (pending.length === 0) {
      return
    }

    lockRef.current = true
    setSaving(true)
    setError('')

    const results = await Promise.all(
      pending.map(async (row) => {
        try {
          await createLotteryBet(token, {
            kind: 'lottery',
            game,
            numbers: { main: row.digits.map((digit) => [digit]), extra: [] },
            multiple: 1,
          })
          return { value: row.value, message: '' }
        } catch (failure) {
          return {
            value: row.value,
            message: failure instanceof Error ? failure.message : '保存失败',
            unauthorized: failure instanceof ApiError && failure.status === 401,
          }
        }
      }),
    )

    const succeeded = results.filter((item) => !item.message).map((item) => item.value)
    const failed = results.filter((item) => item.message)

    if (succeeded.length > 0) {
      setSavedValues((previous) => [...previous, ...succeeded])
    }

    if (failed.length > 0) {
      if (failed.some((item) => item.unauthorized)) {
        setSaving(false)
        lockRef.current = false
        navigate('/login', { state: { from: '/history' } })
        return
      }
      setError(
        `${failed.length} 注没保存成功（${failed[0].message}），再点一次可补加；已成功的不会重复提交`,
      )
    }

    setSaving(false)
    lockRef.current = false
  }

  if (total === 0) {
    return null
  }

  const label = saving
    ? '加注中…'
    : done
      ? `已加注 ${total} 注`
      : !token && ready
        ? `登录后加注 ${pending.length} 注`
        : savedValues.length > 0
          ? `补加 ${pending.length} 注`
          : `一键加注 ${total} 注`

  return (
    <div className="history-auto-bet">
      <button
        type="button"
        className="history-auto-bet__button"
        onClick={() => void handleClick()}
        disabled={!ready || saving || done}
      >
        {label}
      </button>
      <span className="history-auto-bet__meta" aria-live="polite">
        {done ? (
          <button
            type="button"
            className="history-auto-bet__link"
            onClick={() => navigate('/my-bets')}
          >
            查看我的投注
          </button>
        ) : saving ? (
          '正在提交…'
        ) : (
          `${amount} 元 · 单注 ${UNIT_PRICE} 元`
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
