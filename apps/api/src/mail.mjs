import { HttpError } from './lib.mjs'

/**
 * 发信：Resend HTTP API（不用 SMTP —— Vercel 的 serverless 出口对 465/587 不保证）。
 *
 * 没配 RESEND_API_KEY 时降级为「只写日志」：
 * 验证码照常入库，本机做流程联调不会被发信卡住；
 * 线上必须配置，否则用户拿不到验证码。
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

export function createMailer(config) {
  const { resendApiKey, from, replyTo, timeoutMs } = config.mail
  const configured = Boolean(resendApiKey)

  async function send({ to, subject, html, text }) {
    if (!configured) {
      console.warn(`[mail] 未配置 RESEND_API_KEY，跳过发送（收件人 ${to}）`)
      return { delivered: false, provider: 'log' }
    }

    let response
    try {
      response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${resendApiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject,
          html,
          text,
          ...(replyTo ? { reply_to: replyTo } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      console.error('[mail] 连接 Resend 失败：', error instanceof Error ? error.message : String(error))
      throw new HttpError(502, '邮件服务暂时不可用，请稍后重试')
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      console.error(`[mail] Resend 返回 ${response.status}：${body.slice(0, 300)}`)
      throw new HttpError(502, '验证码发送失败，请稍后重试')
    }

    return { delivered: true, provider: 'resend' }
  }

  async function sendCode({ to, code, purpose }) {
    const label = purpose === 'register' ? '注册' : '登录'
    const minutes = config.auth.codeMinutes

    if (!configured) {
      // 本地开发最常见的形态：没有发信服务，但要把码给出来才能联调
      console.warn(`[mail] 未配置 RESEND_API_KEY，${label}验证码只写日志：${to} → ${code}（${minutes} 分钟有效）`)
    }

    const subject = `【体彩助手】${label}验证码 ${code}`
    const text = [
      `你的${label}验证码是 ${code}，${minutes} 分钟内有效。`,
      '如果不是你本人操作，忽略这封邮件即可。',
    ].join('\n')

    const html = `<!doctype html>
<html lang="zh-CN"><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px 24px;">
    <h1 style="margin:0 0 8px;font-size:18px;color:#1f2329;">体彩助手 · ${label}验证码</h1>
    <p style="margin:0 0 20px;color:#5c6370;font-size:14px;">请在页面中输入下面的验证码，${minutes} 分钟内有效。</p>
    <div style="font-size:32px;letter-spacing:8px;font-weight:700;color:#1f2329;background:#f2f4f7;border-radius:8px;padding:14px 0;text-align:center;">${code}</div>
    <p style="margin:20px 0 0;color:#8a919c;font-size:12px;">如果不是你本人操作，忽略这封邮件即可。</p>
  </div>
</body></html>`

    return send({ to, subject, html, text })
  }

  return { sendCode, configured }
}
