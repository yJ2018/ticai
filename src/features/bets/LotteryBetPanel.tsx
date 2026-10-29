import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import { createLotteryBet, type Bet, type LotteryGameKey, type LotteryNumbers } from '../../api/betApi'
import { ApiError } from '../../api/httpClient'
import { useNavigate } from '../../lib/navigation'
import { useAuthStore } from '../../store/authStore'
import './lotteryBet.scss'

type GameMeta = {
  name: string
  positional: boolean
  mainCount: number
  mainMax: number
  extraCount: number
  extraMax: number
}

const GAMES: Record<LotteryGameKey, GameMeta> = {
  pl5: { name: '排列5', positional: true, mainCount: 5, mainMax: 9, extraCount: 0, extraMax: 0 },
  qxc: { name: '七星彩', positional: true, mainCount: 7, mainMax: 9, extraCount: 0, extraMax: 0 },
  dlt: { name: '超级大乐透', positional: false, mainCount: 5, mainMax: 35, extraCount: 2, extraMax: 12 },
}

const POSITIONS: Array<{ key: LotteryGameKey; labels: string[] }> = [
  { key: 'pl5', labels: ['第一位', '第二位', '第三位', '第四位', '第五位'] },
  {
    key: 'qxc',
    labels: ['第一位', '第二位', '第三位', '第四位', '第五位', '第六位', '第七位'],
  },
]

const CSS = {
  overlay: 'lottery-pick',
  card: 'lottery-pick__card',
  head: 'lottery-pick__head',
  close: 'lottery-pick__close',
  rows: 'lottery-pick__rows',
  row: 'lottery-pick__row',
  pos: 'lottery-pick__pos',
  digits: 'lottery-pick__digits',
  digit: 'lottery-pick__digit',
  section: 'lottery-pick__section',
  grid: 'lottery-pick__grid',
  ball: 'lottery-pick__ball',
  summary: 'lottery-pick__summary',
  numbers: 'lottery-pick__numbers',
  multiple: 'lottery-pick__multiple',
  actions: 'lottery-pick__actions',
  error: 'lottery-pick__error',
  success: 'lottery-pick__success',
} as const

function pad2(value: number) {
  return String(value).padStart(2, '0')
}

/** 排列五 / 七星彩 / 大乐透的选号弹层：只做输入，校验以服务端为准。 */
export function LotteryBetPanel({ game, onClose }: { game: LotteryGameKey; onClose: () => void }) {
  const meta = GAMES[game]
  const positions = POSITIONS.find((item) => item.key === game)?.labels ?? []
  const token = useAuthStore((state) => state.token)
  const ready = useAuthStore((state) => state.ready)
  const navigate = useNavigate()

  const [slots, setSlots] = useState<Array<number | null>>(() => Array(meta.mainCount).fill(null))
  const [front, setFront] = useState<number[]>([])
  const [back, setBack] = useState<number[]>([])
  const [multiple, setMultiple] = useState(1)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState<Bet | null>(null)

  useEffect(() => {
    setSlots(Array(meta.mainCount).fill(null))
    setFront([])
    setBack([])
    setMultiple(1)
    setError('')
    setSaved(null)
  }, [game, meta.mainCount])

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  const numbers: LotteryNumbers = useMemo(
    () =>
      meta.positional
        ? { main: slots.filter((value): value is number => value !== null), extra: [] }
        : { main: front, extra: back },
    [meta.positional, slots, front, back],
  )

  const complete = meta.positional
    ? slots.every((value) => value !== null)
    : front.length === meta.mainCount && back.length === meta.extraCount
  const amount = multiple * 2
  const numberText = meta.extraCount
    ? `${numbers.main.map(pad2).join(' ')} + ${numbers.extra.map(pad2).join(' ')}`
    : numbers.main.join(' ')

  function toggleDigit(index: number, digit: number) {
    setSlots((previous) =>
      previous.map((value, position) => (position === index ? (value === digit ? null : digit) : value)),
    )
  }

  function toggleFront(value: number) {
    setFront((previous) => {
      if (previous.includes(value)) {
        return previous.filter((item) => item !== value)
      }
      if (previous.length >= meta.mainCount) {
        return previous
      }
      return [...previous, value].sort((left, right) => left - right)
    })
  }

  function toggleBack(value: number) {
    setBack((previous) => {
      if (previous.includes(value)) {
        return previous.filter((item) => item !== value)
      }
      if (previous.length >= meta.extraCount) {
        return previous
      }
      return [...previous, value].sort((left, right) => left - right)
    })
  }

  function resetForm() {
    setSlots(Array(meta.mainCount).fill(null))
    setFront([])
    setBack([])
    setMultiple(1)
    setSaved(null)
    setError('')
  }

  async function save() {
    if (!ready) {
      return
    }
    if (!token) {
      navigate('/login', { state: { from: '/history' } })
      return
    }
    if (!complete) {
      setError('请先把号码选满')
      return
    }
    setSaving(true)
    setError('')
    try {
      const bet = await createLotteryBet(token, { kind: 'lottery', game, numbers, multiple })
      setSaved(bet)
    } catch (saveError) {
      if (saveError instanceof ApiError && saveError.status === 401) {
        navigate('/login', { state: { from: '/history' } })
        return
      }
      setError(saveError instanceof Error ? saveError.message : '保存失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div
      className={CSS.overlay}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) {
          onClose()
        }
      }}
    >
      <section className={CSS.card} role="dialog" aria-modal="true" aria-label={`${meta.name}选号投注`}>
        <header className={CSS.head}>
          <div>
            <p className="lottery-pick__eyebrow">选号投注</p>
            <h2>
              {meta.name} · {meta.positional ? `${meta.mainCount} 位数字` : `前区 ${meta.mainCount} + 后区 ${meta.extraCount}`}
            </h2>
          </div>
          <button type="button" className={CSS.close} onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        {saved ? (
          <div className={CSS.success}>
            <p className="lottery-pick__success-title">已保存到我的投注</p>
            <p className="lottery-pick__numbers">{saved.title}</p>
            <p className="lottery-pick__success-meta">
              {saved.multiple} 倍 · {saved.amount} 元 · 待开奖，开奖后按官方号码自动判定
            </p>
            <div className={CSS.actions}>
              <button type="button" onClick={resetForm}>
                继续选号
              </button>
              <button
                type="button"
                className="is-primary"
                onClick={() => {
                  onClose()
                  navigate('/my-bets')
                }}
              >
                查看我的投注
              </button>
            </div>
          </div>
        ) : (
          <>
            {meta.positional ? (
              <div className={CSS.rows}>
                {positions.map((label, index) => (
                  <div className={CSS.row} key={label}>
                    <span className={CSS.pos}>{label}</span>
                    <div className={CSS.digits}>
                      {Array.from({ length: meta.mainMax + 1 }, (_, digit) => (
                        <button
                          key={digit}
                          type="button"
                          className={`${CSS.digit}${slots[index] === digit ? ' is-active' : ''}`}
                          onClick={() => toggleDigit(index, digit)}
                          aria-pressed={slots[index] === digit}
                        >
                          {digit}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <>
                <section className={CSS.section}>
                  <h3>前区 · 选 {meta.mainCount} 个（1–{meta.mainMax}）</h3>
                  <div className={CSS.grid}>
                    {Array.from({ length: meta.mainMax }, (_, index) => index + 1).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={`${CSS.ball}${front.includes(value) ? ' is-active' : ''}`}
                        onClick={() => toggleFront(value)}
                        aria-pressed={front.includes(value)}
                      >
                        {pad2(value)}
                      </button>
                    ))}
                  </div>
                </section>
                <section className={CSS.section}>
                  <h3>后区 · 选 {meta.extraCount} 个（1–{meta.extraMax}）</h3>
                  <div className={CSS.grid}>
                    {Array.from({ length: meta.extraMax }, (_, index) => index + 1).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={`${CSS.ball}${back.includes(value) ? ' is-active' : ''}`}
                        onClick={() => toggleBack(value)}
                        aria-pressed={back.includes(value)}
                      >
                        {pad2(value)}
                      </button>
                    ))}
                  </div>
                </section>
              </>
            )}

            <div className={CSS.summary}>
              <span>{numberText || '还没选号'}</span>
              <label className={CSS.multiple}>
                倍数
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={multiple}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    if (Number.isInteger(next) && next >= 1 && next <= 50) {
                      setMultiple(next)
                    }
                  }}
                />
              </label>
              <span className="lottery-pick__amount">{amount} 元</span>
            </div>

            {error && <p className={CSS.error}>{error}</p>}

            <div className={CSS.actions}>
              <button type="button" onClick={onClose}>
                取消
              </button>
              <button type="button" className="is-primary" disabled={saving} onClick={() => void save()}>
                {saving ? '保存中…' : token ? '保存到投注' : '登录后保存'}
              </button>
            </div>
          </>
        )}
      </section>
    </div>,
    document.body,
  )
}
