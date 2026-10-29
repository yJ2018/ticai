import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { envInt, stripTrailingSlash } from './lib.mjs'
import { createLlmConfig } from './llm.mjs'

/**
 * 运行期配置。所有值来自环境变量，不做默认密钥兜底。
 *
 * .env 查找顺序：apps/api/.env → 仓库根 .env。
 * 已存在的 process.env 永远优先（方便命令行临时覆盖）。
 */

/** 允许 0 的整数开关（0 = 关闭），与 envInt 的「必须 > 0」区分 */
function envNonNegativeInt(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') {
    return fallback
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

function loadEnvFileIfPresent(path) {
  if (!existsSync(path)) {
    return false
  }

  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return false
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const separator = line.indexOf('=')
    if (separator <= 0) {
      continue
    }
    const key = line.slice(0, separator).trim()
    if (!key || key in process.env) {
      continue
    }
    let value = line.slice(separator + 1).trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }

  return true
}

export function loadEnv(rootDir) {
  return loadEnvFileIfPresent(resolve(rootDir, 'apps/api/.env')) || loadEnvFileIfPresent(resolve(rootDir, '.env'))
}

function parseOrigins(raw) {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function createConfig() {
  const databaseSsl = (process.env.DATABASE_SSL ?? '').toLowerCase()

  return {
    port: envInt('API_PORT', 3001),
    host: process.env.API_HOST || '127.0.0.1',
    corsOrigins: parseOrigins(process.env.CORS_ORIGINS ?? ''),
    database: {
      url: process.env.DATABASE_URL ?? '',
      ssl: databaseSsl === '1' || databaseSsl === 'true' ? { rejectUnauthorized: false } : false,
      poolMax: envInt('DATABASE_POOL_MAX', 3),
      // 远端库建连慢，默认保留 30 分钟空闲连接；多实例部署可按需调小
      idleTimeoutMs: envInt('DATABASE_IDLE_TIMEOUT_MS', 1_800_000),
      // 长驻 API 每 4 分钟做一次 select 1，避免用户隔一段时间再来时重新握手；0 = 关闭
      keepAliveMs: envNonNegativeInt('DATABASE_KEEPALIVE_MS', 240_000),
    },
    sportteryBase: stripTrailingSlash(process.env.SPORTTERY_BASE || 'https://webapi.sporttery.cn'),
    juhe: {
      webBase: stripTrailingSlash(process.env.JUHE_WEB_BASE || 'http://web.juhe.cn'),
      weatherBase: stripTrailingSlash(process.env.JUHE_WEATHER_BASE || 'http://v.juhe.cn'),
      ipBase: stripTrailingSlash(process.env.JUHE_IP_BASE || 'http://apis.juhe.cn'),
      weatherKey: process.env.JUHE_WEATHER_KEY ?? '',
      horoscopeKey: process.env.JUHE_HOROSCOPE_KEY ?? '',
      ipKey: process.env.JUHE_IP_KEY ?? '',
    },
    timeoutMs: envInt('UPSTREAM_TIMEOUT_MS', 8_000),
    rateLimit: {
      aiPerMinute: envInt('AI_RATE_LIMIT_PER_MIN', 10),
      venuePerMinute: envInt('VENUE_RATE_LIMIT_PER_MIN', 20),
    },
    mail: {
      resendApiKey: process.env.RESEND_API_KEY ?? '',
      // 没配 RESEND_API_KEY 时只把验证码写进日志（本地开发/自建可用）
      from: process.env.MAIL_FROM || 'ticai <onboarding@resend.dev>',
      replyTo: process.env.MAIL_REPLY_TO ?? '',
      timeoutMs: envInt('MAIL_TIMEOUT_MS', 10_000),
      // 仅本地调试：把验证码回给前端。默认关闭，公网开启等于没有验证码
      devEcho: (process.env.MAIL_DEV_ECHO ?? '0') === '1',
    },
    auth: {
      sessionDays: envInt('AUTH_SESSION_DAYS', 30),
      codeMinutes: envInt('AUTH_CODE_MINUTES', 10),
      codeMaxAttempts: envInt('AUTH_CODE_MAX_ATTEMPTS', 5),
      codeCooldownSeconds: envInt('AUTH_CODE_COOLDOWN_SECONDS', 60),
      codeHourlyLimit: envInt('AUTH_CODE_HOURLY_LIMIT', 6),
      codePerIpPerHour: envInt('AUTH_CODE_IP_HOURLY_LIMIT', 20),
      // 密码登录/注册的暴力破解防护（内存态，多实例各自计数）
      loginPerMinutePerIp: envInt('AUTH_LOGIN_PER_MIN_IP', 15),
      loginPerMinutePerEmail: envInt('AUTH_LOGIN_PER_MIN_EMAIL', 8),
      registerPerHourPerIp: envInt('AUTH_REGISTER_PER_HOUR_IP', 10),
      // 生产环境默认拒绝明文密码；本机/内网调试自动放行
      allowInsecure: (process.env.AUTH_ALLOW_INSECURE ?? '0') === '1',
      // OAuth state 的签名密钥；不配时退回微信 appSecret
      stateSecret: process.env.AUTH_STATE_SECRET ?? '',
      // 微信回调结束后跳回的前端地址
      webBaseUrl: stripTrailingSlash(process.env.APP_WEB_BASE || 'http://127.0.0.1:5199'),
      ticketSeconds: envInt('AUTH_TICKET_SECONDS', 120),
    },
    wechat: {
      // 开放平台「网站应用」扫码登录
      appId: process.env.WECHAT_APP_ID ?? '',
      appSecret: process.env.WECHAT_APP_SECRET ?? '',
      redirectUri: process.env.WECHAT_REDIRECT_URI ?? '',
      // 公众号网页授权（微信内打开时用；可以先不配）
      mpAppId: process.env.WECHAT_MP_APP_ID ?? '',
      mpAppSecret: process.env.WECHAT_MP_APP_SECRET ?? '',
      mpRedirectUri: process.env.WECHAT_MP_REDIRECT_URI ?? '',
    },
    // Python 分析服务（apps/analysis）。配置后分析类接口转发过去；不配就走 Node 内联实现。
    analysis: {
      baseUrl: stripTrailingSlash(process.env.ANALYSIS_API_BASE ?? ''),
      timeoutMs: envInt('ANALYSIS_TIMEOUT_MS', 20_000),
    },
    llm: createLlmConfig(),
  }
}
