import { useEffect, useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useNavigate } from '../lib/navigation'
import { takeNavigationState } from '../lib/nav-state'

import {
  getWechatConfig,
  loginWithCode,
  loginWithPassword,
  registerAccount,
  requestEmailCode,
  startWechat,
  type AuthSession,
  type WechatConfig,
} from '../api/authApi'
import { ApiError } from '../api/httpClient'
import { WechatSetupDialog } from '../features/account/WechatSetupDialog'
import { useAuthStore } from '../store/authStore'

/**
 * 登录 / 注册页（可选能力）。
 *
 * 两种模式共用一张表单，由 `?mode=register` 决定：
 *   - 登录：密码登录 / 验证码登录两个 tab；
 *   - 注册：邮箱 + 密码 + 验证码，注册成功直接建立会话。
 *
 * 验证码登录不要求邮箱已注册：验证码通过就证明邮箱归属，未注册的直接建号（无密码），
 * 登录后跳到账号页设置密码，下次就能用密码登录。
 *
 * 验证码有 60 秒冷却，冷却按「用途 + 邮箱」记账：改了邮箱或切换登录方式可以立刻重发，
 * 由服务端再拦一层（同邮箱 60 秒、每小时 6 次）。
 */

type Mode = 'login' | 'register'
type LoginMethod = 'password' | 'code'
type CodePurpose = 'register' | 'login'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const CODE_PATTERN = /^\d{6}$/
const PASSWORD_MIN = 8
const PASSWORD_MAX = 72
const CODE_COOLDOWN_SECONDS = 60

const LOGIN_TABS: Array<{ value: LoginMethod; label: string }> = [
  { value: 'password', label: '密码登录' },
  { value: 'code', label: '验证码登录' },
]

function describeError(error: unknown) {
  if (error instanceof ApiError) {
    return error.message
  }
  if (error instanceof Error && error.message) {
    return error.message
  }
  return '请求失败，请稍后重试'
}

function validateEmail(value: string) {
  const email = value.trim()
  if (!email) {
    return '请输入邮箱'
  }
  if (!EMAIL_PATTERN.test(email)) {
    return '邮箱格式不正确'
  }
  return ''
}

/** 只接受站内路径，避免 ?from= 被塞进外站地址 */
function safeRedirectPath(value: unknown) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/'
}

export function AuthPage() {
  const searchParams = useSearchParams()
  const navigate = useNavigate()

  const token = useAuthStore((state) => state.token)
  const ready = useAuthStore((state) => state.ready)
  const setSession = useAuthStore((state) => state.setSession)

  const mode: Mode = searchParams.get('mode') === 'register' ? 'register' : 'login'
  const isRegister = mode === 'register'
  const purpose: CodePurpose = isRegister ? 'register' : 'login'

  const [loginMethod, setLoginMethod] = useState<LoginMethod>('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sending, setSending] = useState(false)
  const [cooldown, setCooldown] = useState<{ key: string; left: number } | null>(null)
  const [codeHint, setCodeHint] = useState<{
    devCode?: string
    delivered: boolean
    expiresInMinutes: number
  } | null>(null)
  // 刚登录成功的这一次由提交逻辑跳转（带 from），不要让「已登录」守卫再抢一次
  const justAuthenticatedRef = useRef(false)
  const [wechat, setWechat] = useState<WechatConfig | null>(null)
  const [wechatBusy, setWechatBusy] = useState(false)
  const [wechatSetupOpen, setWechatSetupOpen] = useState(false)

  const cooldownKey = `${purpose}:${email.trim().toLowerCase()}`
  const cooldownLeft = cooldown && cooldown.key === cooldownKey ? cooldown.left : 0

  useEffect(() => {
    if (ready && token && !justAuthenticatedRef.current) {
      navigate('/', { replace: true })
    }
  }, [navigate, ready, token])

  // 微信是否已接入由服务端配置决定；未接入时按钮变成「查看接入步骤」
  useEffect(() => {
    let cancelled = false
    getWechatConfig()
      .then((config) => {
        if (!cancelled) {
          setWechat(config)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!cooldown || cooldown.left <= 0) {
      return
    }
    const timer = window.setTimeout(() => {
      setCooldown((prev) => (prev && prev.left > 0 ? { ...prev, left: prev.left - 1 } : prev))
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [cooldown])

  function switchMode(next: Mode) {
    setError('')
    setCode('')
    setPassword('')
    setCodeHint(null)
    navigate(next === 'register' ? '/login?mode=register' : '/login', { replace: true })
  }

  function switchLoginMethod(next: LoginMethod) {
    setError('')
    setLoginMethod(next)
  }

  async function handleRequestCode() {
    if (sending || cooldownLeft > 0) {
      return
    }
    const emailError = validateEmail(email)
    if (emailError) {
      setError(emailError)
      return
    }

    const key = `${purpose}:${email.trim().toLowerCase()}`
    setError('')
    setSending(true)
    try {
      const result = await requestEmailCode(email.trim().toLowerCase(), purpose)
      setCodeHint({
        devCode: result.devCode,
        delivered: result.delivered,
        expiresInMinutes: Math.max(1, Math.round(result.expiresInSeconds / 60)),
      })
      setCooldown({ key, left: CODE_COOLDOWN_SECONDS })
    } catch (requestError) {
      setError(describeError(requestError))
    } finally {
      setSending(false)
    }
  }

  function validateForm() {
    const emailError = validateEmail(email)
    if (emailError) {
      return emailError
    }

    if (isRegister) {
      if (password.length < PASSWORD_MIN) {
        return `密码至少 ${PASSWORD_MIN} 位`
      }
      if (password.length > PASSWORD_MAX) {
        return `密码不能超过 ${PASSWORD_MAX} 位`
      }
      if (!CODE_PATTERN.test(code.trim())) {
        return '请输入 6 位数字验证码'
      }
      return ''
    }

    if (loginMethod === 'code') {
      return CODE_PATTERN.test(code.trim()) ? '' : '请输入 6 位数字验证码'
    }
    return password ? '' : '请输入密码'
  }

  /** 跳微信扫码授权，回来后在 /auth/wechat 用票据换会话。 */
  async function handleWechatLogin() {
    if (wechatBusy) {
      return
    }
    setError('')
    setWechatBusy(true)
    try {
      window.location.href = await startWechat('login')
    } catch (wechatError) {
      setError(describeError(wechatError))
      setWechatBusy(false)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) {
      return
    }

    const formError = validateForm()
    if (formError) {
      setError(formError)
      return
    }

    setError('')
    setSubmitting(true)
    const normalizedEmail = email.trim().toLowerCase()

    try {
      let session: AuthSession
      if (isRegister) {
        session = await registerAccount({ email: normalizedEmail, password, code: code.trim() })
      } else if (loginMethod === 'code') {
        session = await loginWithCode(normalizedEmail, code.trim())
      } else {
        session = await loginWithPassword(normalizedEmail, password)
      }

      justAuthenticatedRef.current = true
      setSession(session.token, session.user)
      const from = takeNavigationState<{ from?: unknown }>()?.from
      if (from) {
        navigate(safeRedirectPath(from), { replace: true })
        return
      }
      // 验证码登录建出来的账号还没有密码：直接送到账号页设置，下次就能用密码登录
      navigate(session.user.hasPassword === false ? '/account?setup=password' : '/', { replace: true })
    } catch (submitError) {
      setError(describeError(submitError))
    } finally {
      setSubmitting(false)
    }
  }

  const showPasswordField = isRegister || loginMethod === 'password'
  const showCodeField = isRegister || loginMethod === 'code'

  return (
    <section className="auth-page">
      <div className="auth-shell">
        <div className="auth-card">
          <header className="auth-card__head">
            <p className="auth-card__eyebrow">账号</p>
            <h2>{isRegister ? '注册账号' : '登录'}</h2>
            <p className="auth-card__desc">
              {isRegister
                ? '注册后可以把投注单存进「我的投注」，开奖后自动结算中奖。'
                : '登录后可以保存投注单、查看中奖记录；不登录也能继续浏览和计算。'}
            </p>
          </header>

          {error && (
            <p className="auth-alert" role="alert">
              {error}
            </p>
          )}

          {!isRegister && (
            <div className="auth-tabs" role="group" aria-label="登录方式">
              {LOGIN_TABS.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  aria-pressed={loginMethod === tab.value}
                  className={loginMethod === tab.value ? 'is-active' : ''}
                  onClick={() => switchLoginMethod(tab.value)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}

          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            <div className="auth-field">
              <label htmlFor="auth-email">邮箱</label>
              <input
                id="auth-email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                disabled={submitting}
                onChange={(event) => {
                  setEmail(event.target.value)
                  // 验证码是发给上一个邮箱的，改邮箱后这条提示就过期了
                  setCodeHint(null)
                }}
              />
              {!isRegister && loginMethod === 'code' && (
                <p className="auth-field__hint">没有注册过的邮箱会自动创建账号，登录后可以设置密码。</p>
              )}
            </div>

            {showPasswordField && (
              <div className="auth-field">
                <label htmlFor="auth-password">密码</label>
                <input
                  id="auth-password"
                  name="password"
                  type="password"
                  autoComplete={isRegister ? 'new-password' : 'current-password'}
                  placeholder={isRegister ? `至少 ${PASSWORD_MIN} 位` : '请输入密码'}
                  value={password}
                  disabled={submitting}
                  onChange={(event) => setPassword(event.target.value)}
                />
                {isRegister && (
                  <p className="auth-field__hint">8–72 位字符，建议字母与数字组合。</p>
                )}
                {!isRegister && loginMethod === 'password' && (
                  <p className="auth-field__hint">
                    忘记密码？改用验证码登录，进账号页就能直接重设密码。
                  </p>
                )}
              </div>
            )}

            {showCodeField && (
              <div className="auth-field">
                <label htmlFor="auth-code">验证码</label>
                <div className="auth-field__row">
                  <input
                    id="auth-code"
                    name="code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="6 位数字"
                    value={code}
                    disabled={submitting}
                    onChange={(event) =>
                      setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                    }
                  />
                  <button
                    type="button"
                    className="btn-ghost auth-code-btn"
                    onClick={() => void handleRequestCode()}
                    disabled={submitting || sending || cooldownLeft > 0}
                  >
                    {sending ? '发送中…' : cooldownLeft > 0 ? `${cooldownLeft}s 后重发` : '获取验证码'}
                  </button>
                </div>

                {codeHint?.devCode && (
                  <p className="auth-field__hint">
                    本地调试验证码：<code>{codeHint.devCode}</code>（线上会发到邮箱）
                  </p>
                )}
                {codeHint?.delivered && (
                  <p className="auth-field__hint">
                    验证码已发送至邮箱，{codeHint.expiresInMinutes} 分钟内有效。
                  </p>
                )}
                {codeHint && !codeHint.delivered && (
                  <p className="auth-field__hint auth-field__hint--warn">
                    未配置发信服务，验证码已写入服务端日志
                  </p>
                )}
              </div>
            )}

            <button type="submit" className="btn-primary auth-submit" disabled={submitting}>
              {submitting
                ? isRegister
                  ? '注册中…'
                  : '登录中…'
                : isRegister
                  ? '注册并登录'
                  : '登录'}
            </button>
          </form>

          {!isRegister && wechat && (
            <div className="auth-wechat">
              <span className="auth-wechat__divider">或</span>
              {wechat.enabled ? (
                <button
                  type="button"
                  className="btn-ghost auth-wechat__btn"
                  disabled={wechatBusy || submitting}
                  onClick={() => void handleWechatLogin()}
                >
                  {wechatBusy ? '跳转中…' : '微信登录'}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-ghost auth-wechat__btn auth-wechat__btn--setup"
                  onClick={() => setWechatSetupOpen(true)}
                >
                  微信登录
                </button>
              )}
              {!wechat.enabled && (
                <p className="auth-wechat__note">
                  尚未接入微信开放平台，
                  <button type="button" className="auth-wechat__link" onClick={() => setWechatSetupOpen(true)}>
                    查看接入步骤
                  </button>
                </p>
              )}
            </div>
          )}

          <WechatSetupDialog
            open={wechatSetupOpen}
            onClose={() => setWechatSetupOpen(false)}
            callbackUrl={wechat?.redirectUri ?? null}
            missing={wechat?.missing ?? []}
          />

          <footer className="auth-card__foot">
            {isRegister ? (
              <p>
                已有账号？
                <button type="button" className="auth-link" onClick={() => switchMode('login')}>
                  去登录
                </button>
              </p>
            ) : (
              <p>
                还没有账号？
                <button type="button" className="auth-link" onClick={() => switchMode('register')}>
                  注册一个
                </button>
              </p>
            )}
            <p className="auth-card__note">登录是可选的：不登录也能正常使用赛事投注与开奖历史。</p>
          </footer>
        </div>

        <Link href="/" className="auth-back">
          ← 返回首页
        </Link>
      </div>
    </section>
  )
}
