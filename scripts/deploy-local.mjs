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
 * 本地构建 + Vercel 预构建产物部署。
 *
 * 为什么要用临时目录：
 * - 仓库根目录的 .vercel 可能被安全软件 / Agent 沙箱保护，CLI 无法读写；
 * - 在系统临时目录创建一次性的 Vercel 项目目录，复制 api/server/dist，
 *   用 VERCEL_ORG_ID + VERCEL_PROJECT_ID 直接构建预构建产物；
 * - 部署完成后清理，不污染仓库，也不需要根目录 .vercel。
 *
 * 前置：npx vercel login（一次即可）。项目 ID 可通过环境变量覆盖。
 */

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const vercel = process.env.VERCEL_CLI ?? 'npx --yes vercel@64'
const defaultOrgId = 'team_WzCWvjcpY00YVeEnkv3Js5Pi'
const defaultProjectId = 'prj_dnpcabvlaKKhkioBQzFVZHdqJcpc'
const keepStage = process.env.KEEP_DEPLOY_STAGE === '1'

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
  const orgId =
    process.env.VERCEL_ORG_ID || linked?.orgId || defaultOrgId
  const projectId =
    process.env.VERCEL_PROJECT_ID || linked?.projectId || defaultProjectId

  process.env.VERCEL_ORG_ID = orgId
  process.env.VERCEL_PROJECT_ID = projectId

  const stage = mkdtempSync(join(tmpdir(), 'ticai-deploy-'))

  for (const entry of ['api', 'server', 'dist']) {
    cpSync(resolve(root, entry), resolve(stage, entry), { recursive: true })
  }
  for (const entry of ['vercel.json', '.vercelignore']) {
    if (existsSync(resolve(root, entry))) {
      cpSync(resolve(root, entry), resolve(stage, entry))
    }
  }

  // 线上函数只跑 api/ + server/，没有任何第三方运行时依赖；
  // 使用最小 package.json，避免 Vercel 为前端依赖白装一遍。
  writeFileSync(
    resolve(stage, 'package.json'),
    JSON.stringify(
      {
        name: 'ticai-deploy',
        private: true,
        version: '0.0.0',
        type: 'module',
        engines: { node: '>=20' },
      },
      null,
      2,
    ),
    'utf8',
  )

  const buildConfig = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'))
  buildConfig.buildCommand = ''
  writeFileSync(
    resolve(stage, 'vercel.deploy.json'),
    JSON.stringify(buildConfig, null, 2),
    'utf8',
  )

  return stage
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
  console.warn(
    '\n[deploy:local] 注意：工作区有未提交改动，本次构建会包含这些改动。',
  )
}

let stage = ''
try {
  run('本地构建静态资源', 'npm run build')

  const builtIndex = readFileSync(resolve(root, 'dist/index.html'), 'utf8')
  if (!builtIndex.includes('/assets/')) {
    fail('dist/index.html 没有指向 hashed assets，请先执行 npm run build。')
  }

  stage = buildStagingDir()
  console.log(`[deploy:local] 临时构建目录：${stage}`)

  const buildConfig = resolve(stage, 'vercel.deploy.json')
  run(
    '生成 Vercel 预构建产物（临时目录，不读写根 .vercel）',
    `${vercel} build --prod --yes --cwd "${stage}" --local-config "${buildConfig}"`,
  )

  const staticDir = resolve(stage, '.vercel/output/static')
  rmSync(staticDir, { recursive: true, force: true })
  cpSync(resolve(root, 'dist'), staticDir, { recursive: true })

  const removedEnvFiles = removeEnvFiles(resolve(stage, '.vercel/output/functions'))
  if (removedEnvFiles > 0) {
    console.log(`[deploy:local] 已从函数产物中移除 ${removedEnvFiles} 个 .env 文件`)
  }

  run(
    '上传预构建产物并发布生产',
    `${vercel} deploy --prebuilt --prod --yes --cwd "${stage}"`,
  )
} catch {
  fail('本地构建或发布失败，请查看上方 Vercel CLI 输出。')
} finally {
  if (stage && !keepStage) {
    try {
      rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (error) {
      // Windows 上 Vercel CLI 偶尔还会短暂占用临时目录，清理失败不应把已成功的部署变成失败。
      console.warn(
        `[deploy:local] 临时目录清理失败（部署已成功）：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  } else if (stage) {
    console.log(`[deploy:local] 保留临时目录：${stage}`)
  }
}

console.log('\n[deploy:local] 完成：本地构建，预构建产物已发布到生产。')
