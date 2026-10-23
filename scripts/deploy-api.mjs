import { execSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 发布 API 项目（Vercel 项目 ticai-service）。
 *
 * 为什么不用仓库根的 .vercel：
 * - 那个目录可能被安全软件 / Agent 沙箱锁住，CLI 读不到 project.json 就直接 EPERM；
 * - 这里在系统临时目录铺一份 apps/api 的产物，用 VERCEL_ORG_ID + VERCEL_PROJECT_ID
 *   指定项目，部署完清理，不污染仓库。
 *
 * 与前端 deploy:local 的区别：API 是源码上传、Vercel 侧构建（装 pg、打包函数），
 * 所以只复制源码与 package.json / vercel.json，不复制 test 与 node_modules。
 *
 * 发布后用 fetch 探一次 /healthz 与 /api/matches；这一步是尽力而为：
 * 国内网络常把 *.vercel.app 解析到错误 IP，探测失败只告警，不影响部署结果。
 *
 * 前置：npx vercel login（一次即可）。
 */

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const apiRoot = resolve(root, 'apps/api')
const vercel = process.env.VERCEL_CLI ?? 'npx --yes vercel@64'
const defaultOrgId = 'team_WzCWvjcpY00YVeEnkv3Js5Pi'
const defaultProjectId = 'prj_Hb73WCv9Q185XRNjjB1tykuC9uxK'
const defaultApiBase = 'https://ticai-service.vercel.app'
const keepStage = process.env.KEEP_DEPLOY_STAGE === '1'

/** 要上传的条目：源码 + 部署配置，跳过测试与依赖。 */
const ENTRIES = ['api', 'src', 'package.json', 'vercel.json']

function capture(command) {
  try {
    return execSync(command, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    }).trim()
  } catch {
    return ''
  }
}

function run(label, command, cwd = root) {
  console.log(`\n[deploy:api] ${label}`)
  execSync(command, { cwd, stdio: 'inherit' })
}

function fail(message) {
  console.error(`\n[deploy:api] ${message}`)
  process.exit(1)
}

function buildStagingDir() {
  const stage = mkdtempSync(join(tmpdir(), 'ticai-api-deploy-'))

  for (const entry of ENTRIES) {
    const from = resolve(apiRoot, entry)
    if (!existsSync(from)) {
      fail(`缺少 ${entry}，请确认在仓库根目录执行`)
    }
    cpSync(from, resolve(stage, entry), { recursive: true })
  }

  return stage
}

async function probe(url, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  let last = ''

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8_000) })
      if (response.ok) {
        const body = await response.json().catch(() => null)
        if (!predicate || predicate(body)) {
          return body
        }
        last = `HTTP ${response.status} 但响应不符合预期`
      } else {
        last = `HTTP ${response.status}`
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))
  }

  throw new Error(`探测 ${url} 超时：${last}`)
}

const whoami = capture(`${vercel} whoami`)
if (!whoami || /logged out/i.test(whoami)) {
  fail(
    'Vercel CLI 未登录。请先执行：\n' +
      '  npx vercel login\n' +
      '然后重新执行 npm run deploy:api。',
  )
}
console.log(`[deploy:api] Vercel 账号：${whoami}`)

const dirty = capture('git status --porcelain')
if (dirty) {
  console.warn('\n[deploy:api] 注意：工作区有未提交改动，本次发布包含这些改动。')
}

const orgId = process.env.VERCEL_ORG_ID || defaultOrgId
const projectId = process.env.VERCEL_PROJECT_ID || defaultProjectId
const apiBase = (process.env.API_BASE || defaultApiBase).replace(/\/+$/, '')

process.env.VERCEL_ORG_ID = orgId
process.env.VERCEL_PROJECT_ID = projectId

let stage = ''
try {
  stage = buildStagingDir()

  const files = readdirSync(stage, { recursive: true }).length
  console.log(`[deploy:api] 临时目录：${stage}（${files} 个条目）`)

  run(
    `发布 API（${apiBase}）`,
    `${vercel} deploy --prod --yes --cwd "${stage}"`,
    stage,
  )

  console.log(`\n[deploy:api] 等待别名生效：${apiBase}`)
  try {
    await probe(`${apiBase}/healthz`, (body) => body?.ok === true, 8_000)
    const matches = await probe(
      `${apiBase}/api/matches`,
      (body) => body?.success === true && Array.isArray(body?.value?.matchInfoList),
      8_000,
    )
    const count = matches.value.matchInfoList.reduce(
      (sum, group) => sum + (group.subMatchList?.length ?? 0),
      0,
    )
    console.log(`[deploy:api] 健康检查通过：在售 ${count} 场`)
  } catch (error) {
    // 国内网络经常把 *.vercel.app 解析到错误 IP，部署本身是成功的，不能因此判定失败
    console.warn(
      `[deploy:api] 健康检查没通过（${error instanceof Error ? error.message : String(error)}）`,
    )
    console.warn(`[deploy:api] 部署已成功；本机 DNS 可能解析不了 Vercel 域名，用浏览器打开 ${apiBase}/healthz 确认即可。`)
  }
} catch (error) {
  console.error(`\n[deploy:api] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  if (stage && !keepStage) {
    try {
      rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (error) {
      // Windows 上 CLI 偶尔还占着临时目录，清理失败不该把已成功的部署变成失败
      console.warn(
        `[deploy:api] 临时目录清理失败（部署已成功）：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  } else if (stage) {
    console.log(`[deploy:api] 保留临时目录：${stage}`)
  }
}

if (!process.exitCode) {
  console.log('\n[deploy:api] 完成：API 已发布到生产。')
}
