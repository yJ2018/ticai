import { useEffect, useState, type FormEvent } from 'react'

import { bindEmail, requestEmailCode, setPassword, type AuthUser } from '../../api/authApi'
import { ApiError } from '../../api/httpClient'

/**
 * 账号页的「邮箱与密码」卡片。
 *
 * 三种状态：
 *   1. 没有邮箱（微信建的账号）→ 绑定邮箱：新邮箱 + 验证码；
 *   2. 有邮箱、没有密码（验证码登录自动建的账号）→ 设置密码；
 *   3. 有邮箱也有密码 → 修改密码。
 *
 * 授权规则在服务端（`setPassword`）：没有密码时任何有效会话都能设置；
 * 已有密码时必须给当前密码，除非这次会话是「验证码登录」建立的——
 * 所以「忘了密码」的正规路径是：退出 → 验证码登录 → 在这里直接设新密码。
 */

type Props = {
  token: string
  user: AuthUser
  /** 从「验证码登录」跳过来时高亮，提示现在可以设置密码 */
  highlight?: boolean
  onUser: (user: AuthUser) => void
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const CODE_PATTERN = /^\d{6}$/
const PASSWORD_MIN = 8
const PASSWORD_MAX = 72
const CODE_COOLDOWN_SECONDS = 60

function describeError(error: unknown) {
  if (error instanceof ApiError) {
    return error.message
  }
  if (error instanceof Error && error.message) {
    return error.message
  }
  return '请求失败，请稍后重试'
}

export function PasswordCard({ token, user, highlight = false, onUser }: Props) {
  const email = user.email
  // 老版本 localStorage 里的用户资料没有 hasPassword：按「已设置」处理，走修改密码分支
  const hasPassword = user.hasPassword !== false
  // 高亮只在「还没有密码」时有效：设置完就把引导收掉
  const showHighlight = highlight && !hasPassword

  // 绑定邮箱
  const [emailDraft, setEmailDraft] = useState('')
  const [bindCode, setBindCode] = useState('')
  const [binding, setBinding] = useState(false)
  const [sending, setSending] = useState(false)
  const [cooldown, setCooldown] = useState<{ key: string; left: number } | null>(null)
  const [codeHint, setCodeHint] = useState<{ devCode?: string; delivered: boolean } | null>(null)

  // 密码
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [saving, setSaving] = useState(false)

  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const cooldownKey = `bind:${emailDraft.trim().toLowerCase()}`
  const cooldownLeft = cooldown && cooldown.key === cooldownKey ? cooldown.left : 0

  useEffect(() => {
    if (!cooldown || cooldown.left <= 0) {
      return
    }
    const timer = window.setTimeout(() => {
      setCooldown((prev) => (prev && prev.left > 0 ? { ...prev, left: prev.left - 1 } : prev))
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [cooldown])

  async function handleSendCode() {
    if (sending || cooldownLeft > 0) {
      return
    }
    const target = emailDraft.trim().toLowerCase()
    if (!EMAIL_PATTERN.test(target)) {
      setError('请输入正确的邮箱')
      return
    }

    setError('')
    setNotice('')
    setSending(true)
    try {
      const result = await requestEmailCode(target, 'bind', token)
      setCodeHint({ devCode: result.devCode, delivered: result.delivered })
      setCooldown({ key: `bind:${target}`, left: CODE_COOLDOWN_SECONDS })
    } catch (sendError) {
      setError(describeError(sendError))
    } finally {
      setSending(false)
    }
  }

  async function handleBind(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (binding) {
      return
    }

    const target = emailDraft.trim().toLowerCase()
    if (!EMAIL_PATTERN.test(target)) {
      setError('请输入正确的邮箱')
      return
    }
    if (!CODE_PATTERN.test(bindCode.trim())) {
      setError('请输入 6 位数字验证码')
      return
    }

    setError('')
    setNotice('')
    setBinding(true)
    try {
      const next = await bindEmail(token, { email: target, code: bindCode.trim() })
      onUser(next)
      setNotice(`邮箱 ${target} 已绑定，接着设置密码就能用密码登录了。`)
      setEmailDraft('')
      setBindCode('')
      setCodeHint(null)
      setCooldown(null)
    } catch (bindError) {
      setError(describeError(bindError))
    } finally {
      setBinding(false)
    }
  }

  async function handleSavePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) {
      return
    }

    if (newPassword.length < PASSWORD_MIN) {
      setError(`密码至少 ${PASSWORD_MIN} 位`)
      return
    }
    if (newPassword.length > PASSWORD_MAX) {
      setError(`密码不能超过 ${PASSWORD_MAX} 位`)
      return
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的密码不一致')
      return
    }

    setError('')
    setNotice('')
    setSaving(true)
    try {
      const result = await setPassword(token, {
        password: newPassword,
        // 还没密码 / 验证码登录的会话都不带当前密码，交给服务端判断
        ...(hasPassword && currentPassword ? { currentPassword } : {}),
      })
      onUser(result.user)
      setNotice(
        result.revokedSessions > 0
          ? `密码已更新，其他设备的 ${result.revokedSessions} 个登录已退出。`
          : hasPassword
            ? '密码已更新，下次用新密码登录即可。'
            : '密码已设置，下次可以直接用邮箱 + 密码登录。',
      )
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (saveError) {
      setError(describeError(saveError))
    } finally {
      setSaving(false)
    }
  }

  const alerts = (
    <>
      {notice && <p className="account-alert account-alert--ok">{notice}</p>}
      {error && (
        <p className="account-alert" role="alert">
          {error}
        </p>
      )}
    </>
  )

  return (
    <section id="password" className={`account-card account-password${showHighlight ? ' is-highlight' : ''}`}>
      <header className="account-card__head">
        <h3>邮箱与密码</h3>
        <span className={`account-badge${hasPassword && email ? ' is-on' : ' is-warn'}`}>
          {!email ? '未绑定邮箱' : hasPassword ? '可密码登录' : '待设置密码'}
        </span>
      </header>

      {!email ? (
        <>
          <p className="account-card__desc">
            这个账号还没有邮箱。绑定后可以设置密码，换设备 / 忘记微信授权时也能用邮箱登录。
          </p>

          {alerts}

          <form className="account-form" onSubmit={handleBind} noValidate>
            <div className="auth-field">
              <label htmlFor="account-email">新邮箱</label>
              <input
                id="account-email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={emailDraft}
                disabled={binding}
                onChange={(event) => {
                  setEmailDraft(event.target.value)
                  // 验证码是发给上一个邮箱的，改邮箱后提示就过期了
                  setCodeHint(null)
                }}
              />
            </div>

            <div className="auth-field">
              <label htmlFor="account-email-code">验证码</label>
              <div className="auth-field__row">
                <input
                  id="account-email-code"
                  name="code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="6 位数字"
                  value={bindCode}
                  disabled={binding}
                  onChange={(event) => setBindCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                />
                <button
                  type="button"
                  className="btn-ghost auth-code-btn"
                  onClick={() => void handleSendCode()}
                  disabled={binding || sending || cooldownLeft > 0}
                >
                  {sending ? '发送中…' : cooldownLeft > 0 ? `${cooldownLeft}s 后重发` : '获取验证码'}
                </button>
              </div>
              {codeHint?.devCode && (
                <p className="auth-field__hint">
                  本地调试验证码：<code>{codeHint.devCode}</code>（线上会发到邮箱）
                </p>
              )}
              {codeHint?.delivered && <p className="auth-field__hint">验证码已发送至邮箱，10 分钟内有效。</p>}
              {codeHint && !codeHint.delivered && !codeHint.devCode && (
                <p className="auth-field__hint auth-field__hint--warn">
                  未配置发信服务，验证码已写入服务端日志
                </p>
              )}
            </div>

            <button type="submit" className="btn-primary account-submit" disabled={binding}>
              {binding ? '绑定中…' : '绑定邮箱'}
            </button>
          </form>
        </>
      ) : (
        <>
          <div className="account-identity">
            <div className="account-identity__main">
              <strong>{email}</strong>
              <span>{hasPassword ? '已设置密码，可以直接密码登录' : '还没有密码，目前只能用验证码登录'}</span>
            </div>
          </div>

          {alerts}

          {showHighlight && (
            <p className="account-card__desc">
              你刚用验证码登录，设置一个密码后下次可以直接用密码登录，不用再等验证码。
            </p>
          )}

          <form className="account-form" onSubmit={handleSavePassword} noValidate>
            {hasPassword && (
              <div className="auth-field">
                <label htmlFor="account-current-password">当前密码</label>
                <input
                  id="account-current-password"
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  placeholder="留空则视为忘记密码"
                  value={currentPassword}
                  disabled={saving}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
                <p className="auth-field__hint">
                  用验证码登录的这次会话可以留空，直接覆盖；否则留空会被要求先验证身份。
                </p>
              </div>
            )}

            <div className="auth-field">
              <label htmlFor="account-new-password">新密码</label>
              <input
                id="account-new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                placeholder={`${PASSWORD_MIN}–${PASSWORD_MAX} 位`}
                value={newPassword}
                disabled={saving}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <p className="auth-field__hint">8–72 位字符，建议字母与数字组合。</p>
            </div>

            <div className="auth-field">
              <label htmlFor="account-confirm-password">确认新密码</label>
              <input
                id="account-confirm-password"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                placeholder="再输入一次"
                value={confirmPassword}
                disabled={saving}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </div>

            <button type="submit" className="btn-primary account-submit" disabled={saving}>
              {saving ? '保存中…' : hasPassword ? '修改密码' : '设置密码'}
            </button>
          </form>

          {hasPassword ? (
            <p className="account-card__note">
              忘记当前密码？退出登录后用验证码登录，回到这里就能直接设置新密码。改密码会同时让其他设备的登录退出。
            </p>
          ) : (
            <p className="account-card__note">
              密码是可选的：不设置也能继续用验证码登录，只是每次都要收一条邮件。
            </p>
          )}
        </>
      )}
    </section>
  )
}
