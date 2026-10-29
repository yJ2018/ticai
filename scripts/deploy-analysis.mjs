import { execSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 发布分析服务（Vercel 项目 ticai-analysis，Python 运行时）。
 *
 * 首次使用需要项目已存在：
 *   npx vercel link --yes --project ticai-analysis   （在 apps/analysis 下执行一次）
 * 或者设 ANALYSIS_PROJECT_ID / ANALYSIS_ORG_ID（Vercel 项目设置里能查到）。
 *
 * 与 deploy:api 一样的思路：临时目录铺一份源码，用 ORG_ID + PROJECT_ID 发布，
 * 不依赖仓库根的 .vercel；只是这次上传的是 Python 源码，Vercel 侧装 requirements.txt。
 *
 * 前置：npx vercel login。发布后探一次 /healthz（失败只告警）。
 */

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const analysisRoot = resolve(root, 'apps/analysis')
const vercel = process.env.VERCEL_CLI ?? 'npx --yes vercel@64'
const defaultOrgId = 'team_WzCWvjcpY00YVeEnkv3Js5Pi'
const defaultAnalysisBase = 'https://ticai-analysis.vercel.app'
const keepStage = process.env.KEEP_DEPLOY_STAGE === '1'

/** 要上传的条目：入口 + 应用包 + 依赖声明 + 部署配置。跳过测试与 .venv。 */
const ENTRIES = ['api', 'app', 'requirements.txt', 'vercel.json']

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

function fail(message) {
  console.error(`\n[deploy:analysis] ${message}`)
  process.exit(1)
}

/** 从 `vercel project ls` 里找出 ticai-analysis 的 projectId（找不到就返回空）。 */
function discoverProjectId() {
  const output = capture(`${vercel} project ls 2>&1`)
  if (!output) {
    return ''
  }
  const line = output
    .split(/\r?\n/)
    .find((row) => row.includes('ticai-analysis'))
  if (!line) {
    return ''
  }
  const match = /prj_[A-Za-z0-9]+/.exec(line)
  return match ? match[0] : ''
}

/** 优先用 `apps/analysis/.vercel/project.json`（`vercel link` 写的，最可靠）。 */
function linkedProject() {
  const file = resolve(analysisRoot, '.vercel', 'project.json')
  if (!existsSync(file)) {
    return {}
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return {
      projectId: typeof parsed.projectId === 'string' ? parsed.projectId : '',
      orgId: typeof parsed.orgId === 'string' ? parsed.orgId : '',
    }
  } catch {
    return {}
  }
}

function buildStagingDir() {
  const stage = mkdtempSync(join(tmpdir(), 'ticai-analysis-deploy-'))

  for (const entry of ENTRIES) {
    const from = resolve(analysisRoot, entry)
    if (!existsSync(from)) {
      fail(`缺少 apps/analysis/${entry}，请确认在仓库根目录执行`)
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
    'Vercel CLI 未登录。请先执行：\n  npx vercel login\n然后重新执行 npm run deploy:analysis。',
  )
}
console.log(`[deploy:analysis] Vercel 账号：${whoami}`)

const linked = linkedProject()
const orgId =
  process.env.ANALYSIS_ORG_ID || process.env.VERCEL_ORG_ID || linked.orgId || defaultOrgId
let projectId = process.env.ANALYSIS_PROJECT_ID || linked.projectId || ''
if (!projectId) {
  projectId = discoverProjectId()
}
if (!projectId) {
  fail(
    '找不到 Vercel 项目 ticai-analysis。首次发布先建项目（二选一）：\n' +
      '  cd apps/analysis && npx vercel link --yes --project ticai-analysis\n' +
      '  或设置 ANALYSIS_PROJECT_ID=prj_xxx（Vercel 项目 Settings 里能查到）\n' +
      `然后重新执行；发布完成后把 Node API 的 ANALYSIS_API_BASE 指向 ${defaultAnalysisBase}。`,
  )
}

const analysisBase = (process.env.ANALYSIS_BASE || defaultAnalysisBase).replace(/\/+$/, '')

process.env.VERCEL_ORG_ID = orgId
process.env.VERCEL_PROJECT_ID = projectId

const dirty = capture('git status --porcelain')
if (dirty) {
  console.warn('\n[deploy:analysis] 注意：工作区有未提交改动，本次发布包含这些改动。')
}

let stage = ''
try {
  stage = buildStagingDir()
  const files = readdirSync(stage, { recursive: true }).length
  console.log(`[deploy:analysis] 临时目录：${stage}（${files} 个条目）`)

  console.log(`\n[deploy:analysis] 发布分析服务（${analysisBase}）`)
  execSync(`${vercel} deploy --prod --yes --cwd "${stage}"`, { cwd: stage, stdio: 'inherit' })

  console.log(`\n[deploy:analysis] 等待别名生效：${analysisBase}`)
  try {
    const health = await probe(`${analysisBase}/healthz`, (body) => body?.ok === true, 8_000)
    console.log(
      `[deploy:analysis] 健康检查通过：service=${health?.service ?? '?'} · 数据库${
        health?.databaseConfigured ? '已配置' : '未配置'
      }`,
    )
  } catch (error) {
    // 国内网络常把 *.vercel.app 解析到错误 IP；以 CLI 的 Ready/Aliased 为准
    const code =
      error?.cause?.code ||
      (/超时|timeout|abort/i.test(error instanceof Error ? error.message : '') ? 'timeout' : 'probe failed')
    console.warn(`[deploy:analysis] 部署成功（线上探测跳过：${code}；浏览器打开 ${analysisBase}/healthz 确认）`)
  }
} catch (error) {
  console.error(`\n[deploy:analysis] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  if (stage && !keepStage) {
    try {
      rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (error) {
      console.warn(
        `[deploy:analysis] 临时目录清理失败（部署已成功）：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  } else if (stage) {
    console.log(`[deploy:analysis] 保留临时目录：${stage}`)
  }
}

if (!process.exitCode) {
  console.log('\n[deploy:analysis] 完成：分析服务已发布到生产。')
}
