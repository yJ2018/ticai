import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useNavigate } from '../lib/navigation'

import { exchangeWechatTicket } from '../api/authApi'
import { ApiError } from '../api/httpClient'
import { useAuthStore } from '../store/authStore'

/**
 * 微信回调落点。
 *
 * 后端回调只把一次性 ticket 放在 URL 里（不是会话 token），这里立刻换成正式会话，
 * 换完 replace 到目标页，避免票据留在历史记录里。
 */
export function WechatCallbackPage() {
  const searchParams = useSearchParams()
  const navigate = useNavigate()
  const setSession = useAuthStore((state) => state.setSession)
  const startedRef = useRef(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (startedRef.current) {
      return
    }
    startedRef.current = true

    const ticket = searchParams.get('ticket') ?? ''
    const mode = searchParams.get('mode')
    const errorText = searchParams.get('error') ?? ''

    if (errorText) {
      setError(errorText)
      return
    }
    if (!ticket) {
      setError('缺少登录票据，请重新发起微信授权')
      return
    }

    exchangeWechatTicket(ticket)
      .then((session) => {
        setSession(session.token, session.user)
        navigate(mode === 'bind' ? '/account?wechat=bound' : '/my-bets', { replace: true })
      })
      .catch((exchangeError) => {
        setError(
          exchangeError instanceof ApiError
            ? exchangeError.message
            : '微信登录失败，请稍后重试',
        )
      })
  }, [navigate, searchParams, setSession])

  return (
    <section className="wechat-callback">
      <div className="wechat-callback__card">
        {!error ? (
          <>
            <span className="wechat-callback__spinner" aria-hidden="true" />
            <h2>正在完成微信登录…</h2>
            <p>正在用一次性票据换取登录状态，请不要关闭页面。</p>
          </>
        ) : (
          <>
            <h2>微信登录未完成</h2>
            <p className="wechat-callback__error">{error}</p>
            <div className="wechat-callback__actions">
              <Link className="btn-primary" href="/login">
                返回登录
              </Link>
              <Link className="btn-ghost" href="/">
                回首页
              </Link>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
