import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 爬虫配置。查找顺序：apps/crawler/.env → 仓库根 .env。 */

export function loadEnv(rootDir) {
  for (const path of [resolve(rootDir, 'apps/crawler/.env'), resolve(rootDir, '.env')]) {
    if (!existsSync(path)) {
      continue
    }
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
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
  }
}

function intEnv(name, fallback) {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export function createConfig() {
  const ssl = (process.env.DATABASE_SSL ?? '').toLowerCase()

  return {
    database: {
      url: process.env.DATABASE_URL ?? '',
      ssl: ssl === '1' || ssl === 'true' ? { rejectUnauthorized: false } : false,
      poolMax: intEnv('CRAWLER_POOL_MAX', 4),
      statementTimeoutMs: intEnv('CRAWL_STATEMENT_TIMEOUT_MS', 180_000),
    },
    sportteryBase: (process.env.SPORTTERY_BASE || 'https://webapi.sporttery.cn').replace(/\/$/, ''),
    // 两个请求之间至少隔这么久，别把体彩当自家接口打
    delayMs: intEnv('CRAWL_DELAY_MS', 1_200),
    timeoutMs: intEnv('CRAWL_TIMEOUT_MS', 20_000),
    // 整轮抓取间隔（分钟），默认 3 小时：history / details 用这个
    intervalMinutes: intEnv('CRAWL_INTERVAL_MINUTES', 180),
    // 赔率变化快，matches 单独提速，默认 30 分钟
    matchesMinutes: intEnv('CRAWL_MATCHES_MINUTES', 30),
    // 对战数据每轮覆盖多少场（默认覆盖全部在售）
    detailsLimit: intEnv('CRAWL_DETAILS_LIMIT', 40),
    // 阵容：赛前 1 小时才公布，单独用更短的周期
    lineupsMinutes: intEnv('CRAWL_LINEUPS_MINUTES', 60),
    // 竞彩销售时段（北京时间），非销售时段不抓比赛相关数据
    betWindowWeekday: process.env.BET_WINDOW_WEEKDAY || '11:00-22:00',
    betWindowWeekend: process.env.BET_WINDOW_WEEKEND || '11:00-23:00',
    // 单条语句上限：跨境写库 + 49 场批量 upsert 时 60s 会撞线
    statementTimeoutMs: intEnv('CRAWL_STATEMENT_TIMEOUT_MS', 180_000),
    // 阵容是唯一可能想脱离销售时段抓的（凌晨场次的官方名单在停售时段公布）
    lineupsGate: (process.env.CRAWL_LINEUPS_GATE ?? '1') !== '0',
    // 每日预热：北京时间几点整跑一轮「仅官方数据」（不受销售时段限制）
    dailyHour: Math.min(intEnv('CRAWL_DAILY_HOUR', 9), 23),
    retries: intEnv('CRAWL_RETRIES', 2),
    historyPageSize: intEnv('CRAWL_HISTORY_PAGE_SIZE', 100),
    maxPages: intEnv('CRAWL_MAX_PAGES', 200),
    gameNos: (process.env.CRAWL_GAMES || '350133,35,85,04')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  }
}
