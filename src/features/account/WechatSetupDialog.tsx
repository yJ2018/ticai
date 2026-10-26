import { useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * 「微信登录还没开通」时的接入指引。
 *
 * 现在没有开放平台资质也能正常用邮箱登录，这里只负责把接入需要的东西讲清楚，
 * 不暴露任何服务端密钥，只展示回调地址与缺失的环境变量名。
 */

type WechatSetupDialogProps = {
  open: boolean
  onClose: () => void
  callbackUrl: string | null
  missing: string[]
}

const DEFAULT_CALLBACK = 'https://<你的 API 域名>/api/auth/wechat/callback'

export function WechatSetupDialog({ open, onClose, callbackUrl, missing }: WechatSetupDialogProps) {
  useEffect(() => {
    if (!open) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  if (!open || typeof document === 'undefined') {
    return null
  }

  return createPortal(
    <div className="wechat-setup" role="dialog" aria-modal="true" aria-labelledby="wechat-setup-title" onClick={onClose}>
      <div className="wechat-setup__card" onClick={(event) => event.stopPropagation()}>
        <header className="wechat-setup__head">
          <div>
            <p className="wechat-setup__eyebrow">微信登录</p>
            <h3 id="wechat-setup-title">接入步骤</h3>
          </div>
          <button type="button" className="wechat-setup__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <p className="wechat-setup__lead">
          微信扫码登录依赖微信开放平台的「网站应用」，需要企业主体和已备案域名。
          在拿到 AppID / AppSecret 之前，邮箱登录、验证码登录、投注与结算都不受影响。
        </p>

        <ol className="wechat-setup__steps">
          <li>
            <strong>注册并认证开放平台</strong>
            <p>
              打开 open.weixin.qq.com，注册开发者账号并完成资质认证（企业主体；个人主体目前无法申请网站应用）。
            </p>
          </li>
          <li>
            <strong>创建「网站应用」</strong>
            <p>
              在应用详情里填写授权回调域——只填 API 的域名，不带 <code>https://</code> 和路径，
              例如 <code>ticai-service.vercel.app</code>。
            </p>
          </li>
          <li>
            <strong>配置环境变量并重新部署 API</strong>
            <pre className="wechat-setup__code">{`WECHAT_APP_ID=应用 AppID
WECHAT_APP_SECRET=应用 AppSecret
WECHAT_REDIRECT_URI=${callbackUrl || DEFAULT_CALLBACK}
APP_WEB_BASE=https://<前端域名>`}</pre>
          </li>
          <li>
            <strong>刷新本页</strong>
            <p>配置生效后，「微信登录」会直接跳转到扫码授权；已经登录的账号可以在「账号」页绑定微信。</p>
          </li>
        </ol>

        {missing.length > 0 && (
          <p className="wechat-setup__missing">服务端当前还缺：{missing.join('、')}</p>
        )}

        <footer className="wechat-setup__foot">
          <button type="button" className="btn-primary" onClick={onClose}>
            知道了
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
