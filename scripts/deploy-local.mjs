import { execSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 前端（Next.js）发布：本地自检 → 上传源码 → Vercel 远端构建。
 *
 * 为什么不用 `vercel build --prebuilt`：
 * Next 的产物 `.vercel/output` 必须由 @vercel/next 生成，而 `vercel build` 在本机
 * 会再 spawn 一层 shell（Windows 上 `spawn cmd.exe`）来跑构建命令，在受限环境/沙箱里
 * 直接 ENOENT；改成本地 `next build` 自检 + 远端构建，行为稳定，且 Vercel 侧的构建
 * 环境与线上一致（环境变量也在那边注入，不需要把 `.env` 带上去）。
 *
 * 发布内容只有前端源码：`src/`、`public/`、`next.config.ts`、`tsconfig.json`、
 * `package.json`、lockfile。`apps/`、`db/`、`scripts/`、`.env*` 一律不上传。
 *
 * 环境变量：
 *   DEPLOY_DRY_RUN=1     只做本地自检与暂存，不上传
 *   KEEP_DEPLOY_STAGE=1  保留临时目录
 *   VERCEL_ORG_ID / VERCEL_PROJECT_ID  覆盖项目关联
 *
 * 前置：npx vercel login（一次即可）。
 */

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const vercel = process.env.VERCEL_CLI ?? 'npx --yes vercel@64'
const defaultOrgId = 'team_WzCWvjcpY00YVeEnkv3Js5Pi'
const defaultProjectId = 'prj_dnpcabvlaKKhkioBQzFVZHdqJcpc'
const keepStage = process.env.KEEP_DEPLOY_STAGE === '1'
const dryRun = process.env.DEPLOY_DRY_RUN === '1'

const SOURCE_DIRS = ['src', 'public']
const SOURCE_FILES = [
  'package.json',
  'package-lock.json',
  'next.config.ts',
  'tsconfig.json',
  'next-env.d.ts',
]

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
  console.log(`\n[deploy:local] ${label}`)
  execSync(command, { cwd, stdio: 'inherit' })
}

function fail(message) {
  console.error(`\n[deploy:local] ${message}`)
  process.exit(1)
}

function readLinkedProject() {
  try {
    const project = JSON.parse(readFileSync(resolve(root, '.vercel/project.json'), 'utf8'))
    return {
      orgId: typeof project.orgId === 'string' ? project.orgId : '',
      projectId: typeof project.projectId === 'string' ? project.projectId : '',
    }
  } catch {
    return null
  }
}

function buildStagingDir() {
  const linked = readLinkedProject()
  process.env.VERCEL_ORG_ID = process.env.VERCEL_ORG_ID || linked?.orgId || defaultOrgId
  process.env.VERCEL_PROJECT_ID =
    process.env.VERCEL_PROJECT_ID || linked?.projectId || defaultProjectId

  const stage = mkdtempSync(join(tmpdir(), 'ticai-web-'))

  for (const dir of SOURCE_DIRS) {
    const from = resolve(root, dir)
    if (!existsSync(from)) {
      fail(`缺少前端目录：${dir}`)
    }
    cpSync(from, resolve(stage, dir), { recursive: true })
  }

  for (const file of SOURCE_FILES) {
    const from = resolve(root, file)
    if (existsSync(from)) {
      cpSync(from, resolve(stage, file))
    }
  }

  const removedEnvFiles = removeEnvFiles(stage)
  if (removedEnvFiles > 0) {
    console.log(`[deploy:local] 暂存目录里剔除了 ${removedEnvFiles} 个 .env 文件`)
  }

  // Next 在 Vercel 上的构建由项目设置决定，这里只声明框架与「不要猜」的构建命令
  writeFileSync(
    resolve(stage, 'vercel.json'),
    JSON.stringify(
      {
        $schema: 'https://openapi.vercel.sh/vercel.json',
        framework: 'nextjs',
        git: { deploymentEnabled: false },
      },
      null,
      2,
    ),
    'utf8',
  )

  return stage
}

function removeEnvFiles(dir) {
  if (!existsSync(dir)) {
    return 0
  }

  let removed = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      removed += removeEnvFiles(path)
    } else if (entry.name === '.env' || entry.name.startsWith('.env.')) {
      rmSync(path, { force: true })
      removed += 1
    }
  }
  return removed
}

const whoami = capture(`${vercel} whoami`)
if (!whoami || /logged out/i.test(whoami)) {
  fail(
    'Vercel CLI 未登录。请先执行：\n' +
      '  npx vercel login\n' +
      '然后重新执行 npm run deploy:local。',
  )
}
console.log(`[deploy:local] Vercel 账号：${whoami}`)

const dirty = capture('git status --porcelain')
if (dirty) {
  console.warn('\n[deploy:local] 注意：工作区有未提交改动，本次发布包含这些改动。')
}

// 浏览器只访问同源 /api，由 next.config.ts 的 rewrite 代理到 API 项目
const apiBase = (process.env.NEXT_PUBLIC_API_BASE || '').replace(/\/+$/, '')
process.env.NEXT_PUBLIC_API_BASE = apiBase
console.log(`[deploy:local] 前端 API 入口：${apiBase || '同源 /api（rewrite 到 ticai-service）'}`)

let stage = ''
try {
  // 本机先跑一遍：类型错误、构建错误在本地就炸，不用等远端几分钟
  run('本地自检构建（next build）', 'npm run build')

  stage = buildStagingDir()
  console.log(`[deploy:local] 暂存目录：${stage}`)

  if (dryRun) {
    console.log('\n[deploy:local] DEPLOY_DRY_RUN=1：自检与暂存完成，跳过上传。')
  } else {
    run(
      '上传源码并由 Vercel 构建发布（生产）',
      `${vercel} deploy --prod --yes --cwd "${stage}"`,
    )
  }
} catch (error) {
  fail(
    `本地自检或发布失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}\n` +
      '  排查提示：KEEP_DEPLOY_STAGE=1 重跑可保留临时目录。',
  )
} finally {
  if (stage && (keepStage || dryRun)) {
    console.log(`[deploy:local] 保留临时目录：${stage}`)
  } else if (stage) {
    try {
      rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (error) {
      console.warn(
        `[deploy:local] 临时目录清理失败（发布已成功）：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
}

console.log(
  dryRun
    ? '\n[deploy:local] 完成：本地自检与暂存通过（未上传）。'
    : '\n[deploy:local] 完成：前端已由 Vercel 构建并发布到生产。',
)
