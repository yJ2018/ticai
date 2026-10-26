import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import {
  fetchIdentities,
  getWechatConfig,
  startWechat,
  unbindIdentity,
  type Identity,
  type WechatConfig,
} from '../api/authApi'
import { ApiError } from '../api/httpClient'
import { WechatSetupDialog } from '../features/account/WechatSetupDialog'
import { useAuthStore } from '../store/authStore'

/**
 * 账号页：展示当前账号与登录方式，并处理微信绑定/解绑。
 *
 * 绑定走的是「带登录态的 OAuth」：start?mode=bind 把用户 id 签进 state，
 * 微信回调时按 state 把身份挂到当前账号，而不是新建账号。
 */

const CHANNEL_LABELS: Record<string, string> = {
  email: '邮箱',
  wechat_web: '微信（网站应用）',
  wechat_mp: '微信（公众号）',
}

function describeError(error: unknown) {
  if (error instanceof ApiError) {
    return error.message
  }
  if (error instanceof Error && error.message) {
    return error.message
  }
  return '请求失败，请稍后重试'
}

function formatDate(value: string | null) {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '—'
  }
  return date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function AccountPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const token = useAuthStore((state) => state.token)
  const user = useAuthStore((state) => state.user)
  const ready = useAuthStore((state) => state.ready)
  const signOut = useAuthStore((state) => state.signOut)

  const [config, setConfig] = useState<WechatConfig | null>(null)
  const [identities, setIdentities] = useState<Identity[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)

  const load = useCallback(async () => {
    if (!token) {
      return
    }
    setLoading(true)
    setError('')
    try {
      const [wechatConfig, list] = await Promise.all([getWechatConfig(), fetchIdentities(token)])
      setConfig(wechatConfig)
      setIdentities(list)
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 401) {
        await signOut()
        navigate('/login', { replace: true, state: { from: '/account' } })
        return
      }
      setError(describeError(loadError))
    } finally {
      setLoading(false)
    }
  }, [navigate, signOut, token])

  useEffect(() => {
    if (!ready) {
      return
    }
    if (!token) {
      navigate('/login', { replace: true, state: { from: '/account' } })
      return
    }
    void load()
  }, [load, navigate, ready, token])

  useEffect(() => {
    if (searchParams.get('wechat') === 'bound') {
      setNotice('微信绑定成功')
      void load()
    }
  }, [load, searchParams])

  const wechatIdentity = identities.find((item) => item.provider === 'wechat')
  const emailIdentity = identities.find((item) => item.provider === 'email')
  const displayName = user?.displayName || user?.email || '体彩助手用户'

  async function handleBind() {
    if (!token || busy) {
      return
    }
    setBusy(true)
    setError('')
    try {
      const authorizeUrl = await startWechat('bind', token)
      window.location.href = authorizeUrl
    } catch (bindError) {
      setError(describeError(bindError))
      setBusy(false)
    }
  }

  async function handleUnbind() {
    if (!token || busy || !wechatIdentity) {
      return
    }
    if (!window.confirm('解绑后将不能用微信登录这个账号，确定继续吗？')) {
      return
    }
    setBusy(true)
    setError('')
    try {
      await unbindIdentity(token, 'wechat')
      setNotice('已解绑微信')
      await load()
    } catch (unbindError) {
      setError(describeError(unbindError))
    } finally {
      setBusy(false)
    }
  }

  if (!ready || (loading && !config)) {
    return (
      <section className="account-page">
        <p className="account-status">正在读取账号信息…</p>
      </section>
    )
  }

  if (!token) {
    return (
      <section className="account-page">
        <p className="account-status">正在跳转登录…</p>
      </section>
    )
  }

  return (
    <section className="account-page">
      <header className="account-hero">
        <div className="account-hero__avatar" aria-hidden="true">
          {user?.avatarUrl ? <img src={user.avatarUrl} alt="" /> : displayName.slice(0, 1).toUpperCase()}
        </div>
        <div className="account-hero__main">
          <h2>{displayName}</h2>
          <p>{user?.email ?? '还没有绑定邮箱'}</p>
        </div>
        <div className="account-hero__actions">
          <Link className="btn-primary" to="/my-bets">
            我的投注
          </Link>
          <button type="button" className="btn-ghost" onClick={() => void signOut().then(() => navigate('/'))}>
            退出登录
          </button>
        </div>
      </header>

      {notice && <p className="account-alert account-alert--ok">{notice}</p>}
      {error && <p className="account-alert">{error}</p>}

      <div className="account-grid">
        <section className="account-card">
          <header className="account-card__head">
            <h3>微信</h3>
            <span className={`account-badge${wechatIdentity ? ' is-on' : ''}`}>
              {wechatIdentity ? '已绑定' : '未绑定'}
            </span>
          </header>

          <p className="account-card__desc">
            绑定后可以直接用微信扫码登录，投注记录不会丢。
          </p>

          {wechatIdentity ? (
            <div className="account-identity">
              <div className="account-identity__main">
                <strong>{wechatIdentity.nickname || '微信用户'}</strong>
                <span>{CHANNEL_LABELS[wechatIdentity.channel] ?? wechatIdentity.channel}</span>
                <span className="account-identity__hint">openid {wechatIdentity.uidHint || '—'}</span>
              </div>
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => void handleUnbind()}>
                解绑
              </button>
            </div>
          ) : config?.enabled ? (
            <button type="button" className="btn-primary account-bind" disabled={busy} onClick={() => void handleBind()}>
              {busy ? '跳转中…' : '绑定微信'}
            </button>
          ) : (
            <>
              <p className="account-card__empty">
                微信登录还没有接入（需要微信开放平台的「网站应用」，企业主体 + 已备案域名）。
              </p>
              <button type="button" className="btn-ghost account-bind" onClick={() => setSetupOpen(true)}>
                查看接入步骤
              </button>
            </>
          )}
        </section>

        <section className="account-card">
          <header className="account-card__head">
            <h3>登录方式</h3>
            <span className="account-card__count">{identities.length} 种</span>
          </header>

          <ul className="account-list">
            {identities.map((item) => (
              <li key={`${item.provider}-${item.channel}`}>
                <div>
                  <strong>{CHANNEL_LABELS[item.channel] ?? item.channel}</strong>
                  <p>{item.provider === 'email' ? user?.email ?? '—' : item.nickname || '微信用户'}</p>
                </div>
                <span className="account-list__time">最近使用 {formatDate(item.lastLoginAt)}</span>
              </li>
            ))}
            {identities.length === 0 && <li className="account-list__empty">暂无登录方式</li>}
          </ul>

          {!emailIdentity && (
            <p className="account-card__note">
              这个账号还没有邮箱密码，目前只能通过微信登录。邮箱绑定会在后续版本补上。
            </p>
          )}
        </section>
      </div>

      <WechatSetupDialog
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        callbackUrl={config?.redirectUri ?? null}
        missing={config?.missing ?? []}
      />
    </section>
  )
}
