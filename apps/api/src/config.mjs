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
    llm: createLlmConfig(),
  }
}
