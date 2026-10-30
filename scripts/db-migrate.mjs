import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadEnv } from '../apps/api/src/config.mjs'

/**
 * 数据库迁移执行器（零框架，只依赖 pg）。
 *
 *   node scripts/db-migrate.mjs            应用迁移 + 种子（默认）
 *   node scripts/db-migrate.mjs status     查看已应用 / 待应用
 *   node scripts/db-migrate.mjs seed       只重跑种子（幂等）
 *   node scripts/db-migrate.mjs verify     跑一遍结构与约束自检
 *
 * 设计要点：
 * - 每个迁移文件独立事务，失败即回滚，不会留下半截 schema；
 * - schema_migration 记录 checksum，已应用文件被改动会告警（多半是误改历史迁移）；
 * - 全程持有 advisory lock，两个进程同时部署不会互相踩；
 * - 与 Vercel 无关，本地、CI、国内 VPS 都用同一条命令。
 */

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const MIGRATION_DIR = resolve(root, 'db/migrations')
const SEED_DIR = resolve(root, 'db/seed')
const LOCK_KEY = 'ticai:migrate'

const envLoaded = loadEnv(root)
const DATABASE_URL = process.env.DATABASE_URL ?? ''
const SSL_MODE = process.env.DATABASE_SSL ?? ''
const COMMAND = process.argv[2] ?? 'up'
const SKIP_SEED = process.argv.includes('--no-seed')

if (COMMAND === 'up' && !envLoaded && !process.env.DATABASE_URL) {
  console.warn('[db] 未找到 .env，也没有通过环境变量提供 DATABASE_URL')
}

function fail(message) {
  console.error(`\n[db] ${message}\n`)
  process.exit(1)
}

async function loadPg() {
  try {
    const mod = await import('pg')
    return mod.default ?? mod
  } catch (error) {
    fail(
      ' 缺少依赖 pg，请先执行 npm install。\n' +
        ` 原始错误：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function listSql(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }

  return names
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, path: resolve(dir, name) }))
}

function checksumOf(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function createClient(Pg) {
  const ssl =
    SSL_MODE === '1' || SSL_MODE === 'true'
      ? { rejectUnauthorized: false }
      : SSL_MODE === '0' || SSL_MODE === 'false'
        ? false
        : undefined

  return new Pg.Client({
    connectionString: DATABASE_URL,
    ssl,
    // 迁移是长事务，冷启动慢的库给足时间
    connectionTimeoutMillis: 15_000,
    statement_timeout: 120_000,
  })
}

async function ensureMigrationTable(client) {
  await client.query(`
    create table if not exists schema_migration (
      name        text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now(),
      duration_ms integer not null
    )
  `)
}

async function readApplied(client) {
  const { rows } = await client.query('select name, checksum, applied_at from schema_migration')
  return new Map(rows.map((row) => [row.name, row]))
}

async function runFile(client, file) {
  const sql = await readFile(file.path, 'utf8')
  const startedAt = Date.now()

  await client.query('begin')
  try {
    await client.query(sql)
    const duration = Date.now() - startedAt
    await client.query(
      'insert into schema_migration (name, checksum, duration_ms) values ($1, $2, $3)',
      [file.name, checksumOf(sql), duration],
    )
    await client.query('commit')
    return duration
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  }
}

async function commandUp(client) {
  await ensureMigrationTable(client)
  const applied = await readApplied(client)
  const files = await listSql(MIGRATION_DIR)

  if (files.length === 0) {
    console.log('[db] 没有找到迁移文件')
  }

  let count = 0
  for (const file of files) {
    const done = applied.get(file.name)
    if (done) {
      const current = checksumOf(await readFile(file.path, 'utf8'))
      if (current !== done.checksum) {
        console.warn(`[db] ⚠ ${file.name} 在应用后被修改，checksum 不一致（已跳过）`)
      }
      continue
    }

    process.stdout.write(`[db] 应用 ${file.name} ... `)
    try {
      const duration = await runFile(client, file)
      console.log(`ok (${duration}ms)`)
      count += 1
    } catch (error) {
      console.log('失败')
      throw error
    }
  }

  if (count === 0) {
    console.log('[db] 没有待应用的迁移')
  }

  if (!SKIP_SEED) {
    await commandSeed(client)
  }
}

async function commandSeed(client) {
  const files = await listSql(SEED_DIR)
  if (files.length === 0) {
    return
  }

  for (const file of files) {
    process.stdout.write(`[db] 种子 ${file.name} ... `)
    await client.query('begin')
    try {
      await client.query(await readFile(file.path, 'utf8'))
      await client.query('commit')
      console.log('ok')
    } catch (error) {
      await client.query('rollback').catch(() => {})
      console.log('失败')
      throw error
    }
  }
}

async function commandStatus(client) {
  await ensureMigrationTable(client)
  const applied = await readApplied(client)
  const files = await listSql(MIGRATION_DIR)

  console.log(`[db] 迁移目录：${MIGRATION_DIR}`)
  for (const file of files) {
    const done = applied.get(file.name)
    const mark = done ? '✓' : '·'
    const when = done ? new Date(done.applied_at).toISOString() : '待应用'
    console.log(`  ${mark} ${file.name.padEnd(28)} ${when}`)
  }

  const snapshotTable = await client.query(
    "select to_regclass('public.lottery_analysis_snapshot') is not null as exists",
  )
  const hasSnapshots = Boolean(snapshotTable.rows[0]?.exists)

  const { rows } = await client.query(`
    select 'lottery_draw' as t, count(*)::int as n from lottery_draw
    union all select 'match', count(*)::int from match
    union all select 'match_odds_snapshot', count(*)::int from match_odds_snapshot
    union all select 'crawl_run', count(*)::int from crawl_run
    union all select 'lottery_game', count(*)::int from lottery_game
    ${hasSnapshots ? "union all select 'lottery_analysis_snapshot', count(*)::int from lottery_analysis_snapshot" : ''}
  `)
  console.log('\n[db] 当前数据量')
  for (const row of rows) {
    console.log(`  ${row.t.padEnd(28)} ${row.n}`)
  }

  if (hasSnapshots) {
    const { rows: analysis } = await client.query(`
      select game_key, kind, config_key, through_issue, through_draw_date, draw_count,
             latest_issue_seq > through_issue_seq as stale
      from lottery_analysis_latest
      order by game_key, kind, config_key
    `)
    if (analysis.length > 0) {
      console.log('\n[db] 分析快照（最新）')
      for (const row of analysis) {
        console.log(
          `  ${row.stale ? '⚠' : '✓'} ${row.game_key.padEnd(4)} ${row.kind.padEnd(12)} ` +
            `${row.config_key.padEnd(44)} 基准 ${row.through_issue} · ${row.draw_count} 期`,
        )
      }
    }
  }

  const { rows: runs } = await client.query(`
    select source, max(finished_at) as last_ok
    from crawl_run where status = 'ok'
    group by source order by source
  `)
  if (runs.length > 0) {
    console.log('\n[db] 最近成功抓取')
    for (const row of runs) {
      const seconds = row.last_ok ? Math.round((Date.now() - new Date(row.last_ok).getTime()) / 1000) : null
      console.log(`  ${row.source.padEnd(28)} ${seconds === null ? '-' : `${seconds}s 前`}`)
    }
  }
}

/**
 * 结构自检：不依赖真实业务数据，用事务夹具验证生成列/视图/唯一约束，
 * 跑完一律 rollback，绝不留脏数据。
 */
async function commandVerify(client) {
  const results = []
  const check = async (name, fn) => {
    try {
      const detail = await fn()
      results.push({ ok: true, name, detail })
    } catch (error) {
      results.push({ ok: false, name, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  const requiredTables = [
    'lottery_game', 'lottery_draw', 'lottery_prize_level',
    'league', 'team', 'team_alias', 'match', 'match_odds_snapshot',
    'player', 'injury', 'match_lineup', 'match_lineup_player',
    'external_ref', 'crawl_run',
  ]

  await check('14 张核心表存在', async () => {
    const { rows } = await client.query(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name = any($1::text[])`,
      [requiredTables],
    )
    const missing = requiredTables.filter((name) => !rows.some((row) => row.table_name === name))
    if (missing.length > 0) {
      throw new Error(`缺少：${missing.join(', ')}`)
    }
    return `${rows.length}/14`
  })

  await check('两个视图存在', async () => {
    const { rows } = await client.query(
      `select table_name from information_schema.views
       where table_schema = 'public' and table_name in ('match_side','match_odds_latest')`,
    )
    if (rows.length !== 2) {
      throw new Error(`只找到 ${rows.length} 个视图`)
    }
    return 'match_side, match_odds_latest'
  })

  await check('match_result 已固化总进球赔率列', async () => {
    const { rows } = await client.query(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'match_result'
         and column_name in ('ttg_odds','ttg_odds_captured_at')`,
    )
    if (rows.length !== 2) {
      throw new Error('缺少 ttg_odds / ttg_odds_captured_at，先跑 npm run db:migrate')
    }
    return 'ttg_odds, ttg_odds_captured_at'
  })

  await check('四个彩种已种子化', async () => {
    const { rows } = await client.query(
      `select game_key from lottery_game where game_key = any($1::text[]) order by game_key`,
      [['pl3', 'pl5', 'dlt', 'qxc']],
    )
    if (rows.length !== 4) {
      throw new Error(`只有 ${rows.length} 个，先跑 npm run db:seed`)
    }
    return rows.map((row) => row.game_key).join(', ')
  })

  await check('htft 生成列计算正确', async () => {
    await client.query('begin')
    try {
      const { rows: leagueRows } = await client.query(
        `insert into league (name) values ('__verify__') returning id`,
      )
      const leagueId = leagueRows[0].id
      const { rows: teamRows } = await client.query(
        `insert into team (sporttery_id, name_abbr) values
           (990001, '__verify_home__'), (990002, '__verify_away__')
         returning id`,
      )
      const [home, away] = teamRows.map((row) => row.id)
      const { rows } = await client.query(
        `insert into match
           (sporttery_match_id, kickoff_at, league_id, league_name, home_team_id, away_team_id,
            home_name, away_name, status, home_score, away_score, home_half_score, away_half_score)
         values (990001, now(), $1, '__verify__', $2, $3, 'h', 'a', 'finished', 2, 1, 0, 0)
         returning htft`,
        [leagueId, home, away],
      )
      if (rows[0]?.htft !== 'dh') {
        throw new Error(`期望 dh，实际 ${rows[0]?.htft}`)
      }
      return '2:1 / 半场 0:0 → dh'
    } finally {
      await client.query('rollback')
    }
  })

  await check('match_side 客队视角翻转 h/a', async () => {
    await client.query('begin')
    try {
      const { rows: leagues } = await client.query(
        `insert into league (name) values ('__verify__') returning id`,
      )
      const { rows: teams } = await client.query(
        `insert into team (sporttery_id, name_abbr)
         values (990001, '__verify_home__'), (990002, '__verify_away__') returning id`,
      )
      const { rows } = await client.query(
        `insert into match
           (sporttery_match_id, kickoff_at, league_id, league_name, home_team_id, away_team_id,
            home_name, away_name, status, home_score, away_score, home_half_score, away_half_score)
         values (990001, now(), $1, '__verify__', $2, $3, 'h', 'a', 'finished', 2, 1, 0, 0)
         returning id`,
        [leagues[0].id, teams[0].id, teams[1].id],
      )
      const { rows: sides } = await client.query(
        `select htft from match_side where match_id = $1 and side = 'away'`,
        [rows[0].id],
      )
      if (sides[0]?.htft !== 'da') {
        throw new Error(`期望 da，实际 ${sides[0]?.htft}`)
      }
      return 'dh → da'
    } finally {
      await client.query('rollback')
    }
  })

  await check('分析快照：同 (彩种, 分析, 参数, 期号) 只能有一行', async () => {
    await client.query('begin')
    try {
      const insert = `insert into lottery_analysis_snapshot
          (game_no, kind, config_key, through_issue, through_issue_seq, through_draw_date, draw_count, payload)
        values ('350133', 'prediction', '__verify__', '__verify__', 1, current_date, 1, '{}'::jsonb)`
      await client.query(insert)

      let duplicated = false
      try {
        await client.query('savepoint s')
        await client.query(insert)
        duplicated = true
      } catch {
        await client.query('rollback to savepoint s')
      }
      if (duplicated) {
        throw new Error('同一期同一参数被重复写入')
      }

      const { rows } = await client.query(
        `select count(*)::int as n from lottery_analysis_latest where config_key = '__verify__'`,
      )
      if (rows[0]?.n !== 1) {
        throw new Error(`lottery_analysis_latest 视图应返回 1 行，实际 ${rows[0]?.n}`)
      }
      return '重复写入被拒绝 · 视图可查'
    } finally {
      await client.query('rollback')
    }
  })

  await check('(game_no, issue) 唯一约束生效', async () => {
    await client.query('begin')
    try {
      await client.query(
        `insert into lottery_draw (game_no, issue, issue_seq, draw_date, main_numbers, numbers_text)
         values ('35', '__verify__', 1, current_date, '{1,2,3}', '1 2 3')`,
      )
      let duplicated = false
      try {
        await client.query('savepoint s')
        await client.query(
          `insert into lottery_draw (game_no, issue, issue_seq, draw_date, main_numbers, numbers_text)
           values ('35', '__verify__', 1, current_date, '{1,2,3}', '1 2 3')`,
        )
        duplicated = true
      } catch {
        await client.query('rollback to savepoint s')
      }
      if (duplicated) {
        throw new Error('重复期号被写入，唯一约束缺失')
      }
      return '(35, __verify__) 被拒绝'
    } finally {
      await client.query('rollback')
    }
  })

  await check('赔率快照按 content_hash 去重', async () => {
    await client.query('begin')
    try {
      const { rows: leagueRows } = await client.query(
        `insert into league (name) values ('__verify__') returning id`,
      )
      const { rows: teamRows } = await client.query(
        `insert into team (sporttery_id, name_abbr) values (990003, '__verify_t1__'), (990004, '__verify_t2__') returning id`,
      )
      const { rows: matchRows } = await client.query(
        `insert into match (sporttery_match_id, kickoff_at, league_id, league_name, home_team_id, away_team_id, home_name, away_name)
         values (990003, now(), $1, '__verify__', $2, $3, 'h', 'a') returning id`,
        [leagueRows[0].id, teamRows[0].id, teamRows[1].id],
      )
      const matchId = matchRows[0].id
      const insert = `insert into match_odds_snapshot (match_id, odds, content_hash) values ($1, '{}'::jsonb, 'dup')`
      await client.query(insert, [matchId])
      let duplicated = false
      try {
        await client.query('savepoint s')
        await client.query(insert, [matchId])
        duplicated = true
      } catch {
        await client.query('rollback to savepoint s')
      }
      if (duplicated) {
        throw new Error('相同 hash 被重复写入')
      }
      return '同内容第二次写入被拒绝'
    } finally {
      await client.query('rollback')
    }
  })

  let failed = 0
  console.log('[db] 结构自检')
  for (const result of results) {
    if (!result.ok) {
      failed += 1
    }
    console.log(`  ${result.ok ? '✓' : '✗'} ${result.name}  ${result.detail ?? ''}`)
  }

  if (failed > 0) {
    throw new Error(`${failed} 项自检失败`)
  }
  console.log(`\n[db] 全部通过（${results.length} 项）`)
}

async function main() {
  if (!DATABASE_URL) {
    fail('缺少 DATABASE_URL，请在 .env 里配置（参考 .env.example）')
  }

  const Pg = await loadPg()
  const client = createClient(Pg)

  try {
    await client.connect()
  } catch (error) {
    fail(`连不上数据库：${error instanceof Error ? error.message : String(error)}`)
  }

  let locked = false
  try {
    if (COMMAND !== 'status') {
      await client.query('select pg_advisory_lock(hashtext($1))', [LOCK_KEY])
      locked = true
    }

    if (COMMAND === 'up') {
      await commandUp(client)
    } else if (COMMAND === 'seed') {
      await ensureMigrationTable(client)
      await commandSeed(client)
    } else if (COMMAND === 'status') {
      await commandStatus(client)
    } else if (COMMAND === 'verify') {
      await commandVerify(client)
    } else {
      fail(`未知命令：${COMMAND}（可用：up | seed | status | verify）`)
    }
  } catch (error) {
    console.error(`\n[db] 失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  } finally {
    if (locked) {
      await client.query('select pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => {})
    }
    await client.end().catch(() => {})
  }
}

main().catch((error) => {
  console.error('[db] 未处理异常：', error)
  process.exit(1)
})
