import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import { createLotteryBet, type Bet, type LotteryGameKey } from '../../api/betApi'
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

/** 与服务端一致的单张注数上限 */
const MAX_UNITS = 1000

function pad2(value: number) {
  return String(value).padStart(2, '0')
}

function combinationCount(n: number, k: number) {
  if (n < k || k < 0) {
    return 0
  }
  let result = 1
  for (let index = 1; index <= k; index += 1) {
    result = (result * (n - k + index)) / index
  }
  return Math.round(result)
}

/** 排列五 / 七星彩 / 大乐透选号弹层：支持复式，注数与金额由服务端最终确认。 */
export function LotteryBetPanel({ game, onClose }: { game: LotteryGameKey; onClose: () => void }) {
  const meta = GAMES[game]
  const positions = POSITIONS.find((item) => item.key === game)?.labels ?? []
  const token = useAuthStore((state) => state.token)
  const ready = useAuthStore((state) => state.ready)
  const navigate = useNavigate()

  const [groups, setGroups] = useState<number[][]>(() =>
    meta.positional ? Array.from({ length: meta.mainCount }, () => []) : [],
  )
  const [front, setFront] = useState<number[]>([])
  const [back, setBack] = useState<number[]>([])
  const [multiple, setMultiple] = useState(1)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState<Bet | null>(null)

  useEffect(() => {
    setGroups(meta.positional ? Array.from({ length: meta.mainCount }, () => []) : [])
    setFront([])
    setBack([])
    setMultiple(1)
    setError('')
    setSaved(null)
  }, [game, meta.positional, meta.mainCount])

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

  const combos = useMemo(() => {
    if (meta.positional) {
      return groups.reduce((product, digits) => product * digits.length, 1)
    }
    return combinationCount(front.length, meta.mainCount) * combinationCount(back.length, meta.extraCount)
  }, [meta.positional, meta.mainCount, meta.extraCount, groups, front.length, back.length])

  const units = combos * multiple
  const amount = units * 2
  const overLimit = units > MAX_UNITS
  const complete = meta.positional
    ? groups.every((digits) => digits.length > 0)
    : front.length >= meta.mainCount && back.length >= meta.extraCount

  const numberText = meta.positional
    ? groups.map((digits) => digits.join(',')).join(' | ')
    : `${front.map(pad2).join(' ')} + ${back.map(pad2).join(' ')}`

  function toggleDigit(index: number, digit: number) {
    setGroups((previous) =>
      previous.map((digits, position) => {
        if (position !== index) {
          return digits
        }
        return digits.includes(digit) ? digits.filter((item) => item !== digit) : [...digits, digit].sort((a, b) => a - b)
      }),
    )
  }

  function toggleNumber(value: number, side: 'front' | 'back') {
    const list = side === 'front' ? front : back
    const setter = side === 'front' ? setFront : setBack
    setter(list.includes(value) ? list.filter((item) => item !== value) : [...list, value].sort((a, b) => a - b))
  }

  function resetForm() {
    setGroups(meta.positional ? Array.from({ length: meta.mainCount }, () => []) : [])
    setFront([])
    setBack([])
    setMultiple(1)
    setError('')
    setSaved(null)
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
      setError(meta.positional ? '每一位至少选 1 个数字' : `前区至少选 ${meta.mainCount} 个、后区至少选 ${meta.extraCount} 个`)
      return
    }
    if (overLimit) {
      setError(`单张最多 ${MAX_UNITS} 注（${MAX_UNITS * 2} 元），当前 ${units} 注，请减少号码或倍数`)
      return
    }
    setSaving(true)
    setError('')
    try {
      const numbers = meta.positional
        ? { main: groups.map((digits) => [...digits]), extra: [] }
        : { main: [...front], extra: [...back] }
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
      className="lottery-pick"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) {
          onClose()
        }
      }}
    >
      <section className="lottery-pick__card" role="dialog" aria-modal="true" aria-label={`${meta.name}选号投注`}>
        <header className="lottery-pick__head">
          <div>
            <p className="lottery-pick__eyebrow">选号投注 · 支持复式</p>
            <h2>
              {meta.name} ·{' '}
              {meta.positional
                ? `${meta.mainCount} 位数字（每位可多选）`
                : `前区 ${meta.mainCount}+ / 后区 ${meta.extraCount}+`}
            </h2>
          </div>
          <button type="button" className="lottery-pick__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        {saved ? (
          <div className="lottery-pick__success">
            <p className="lottery-pick__success-title">已保存到我的投注</p>
            <p className="lottery-pick__numbers">{saved.title}</p>
            <p className="lottery-pick__success-meta">
              {saved.units} 注 · {saved.multiple} 倍 · {saved.amount} 元 · 待开奖，开奖后按官方号码自动判定
            </p>
            <div className="lottery-pick__actions">
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
              <div className="lottery-pick__rows">
                {positions.map((label, index) => (
                  <div className="lottery-pick__row" key={label}>
                    <span className="lottery-pick__pos">{label}</span>
                    <div className="lottery-pick__digits">
                      {Array.from({ length: meta.mainMax + 1 }, (_, digit) => (
                        <button
                          key={digit}
                          type="button"
                          className={`lottery-pick__digit${groups[index]?.includes(digit) ? ' is-active' : ''}`}
                          onClick={() => toggleDigit(index, digit)}
                          aria-pressed={groups[index]?.includes(digit) ?? false}
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
                <section className="lottery-pick__section">
                  <h3>
                    前区 · 至少 {meta.mainCount} 个（1–{meta.mainMax}）
                    {front.length > meta.mainCount ? ` · 已选 ${front.length} 个` : ''}
                  </h3>
                  <div className="lottery-pick__grid">
                    {Array.from({ length: meta.mainMax }, (_, index) => index + 1).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={`lottery-pick__ball${front.includes(value) ? ' is-active' : ''}`}
                        onClick={() => toggleNumber(value, 'front')}
                        aria-pressed={front.includes(value)}
                      >
                        {pad2(value)}
                      </button>
                    ))}
                  </div>
                </section>
                <section className="lottery-pick__section">
                  <h3>
                    后区 · 至少 {meta.extraCount} 个（1–{meta.extraMax}）
                    {back.length > meta.extraCount ? ` · 已选 ${back.length} 个` : ''}
                  </h3>
                  <div className="lottery-pick__grid">
                    {Array.from({ length: meta.extraMax }, (_, index) => index + 1).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={`lottery-pick__ball${back.includes(value) ? ' is-active' : ''}`}
                        onClick={() => toggleNumber(value, 'back')}
                        aria-pressed={back.includes(value)}
                      >
                        {pad2(value)}
                      </button>
                    ))}
                  </div>
                </section>
              </>
            )}

            <div className="lottery-pick__summary">
              <span>{numberText || '还没选号'}</span>
              <span className="lottery-pick__combos">
                {combos > 0 ? `${combos} 注` : '—'}
                {multiple > 1 ? ` × ${multiple} 倍` : ''}
              </span>
              <label className="lottery-pick__multiple">
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

            {overLimit && (
              <p className="lottery-pick__error">
                单张最多 {MAX_UNITS} 注（{MAX_UNITS * 2} 元），当前 {units} 注，请减少号码或倍数
              </p>
            )}
            {error && <p className="lottery-pick__error">{error}</p>}

            <div className="lottery-pick__actions">
              <button type="button" onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className="is-primary"
                disabled={saving || overLimit}
                onClick={() => void save()}
              >
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
