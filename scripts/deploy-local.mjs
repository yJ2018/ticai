import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 本地构建 + Vercel 预构建产物部署。
 *
 * 目的：不在 Vercel 云端构建，源码和 .env 也不上传；只上传本地 .vercel/output。
 * 前置：npx vercel login && npx vercel link
 */

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
// 固定 CLI 大版本，避免 npx 每次拉到新的 breaking change
const vercel = process.env.VERCEL_CLI ?? 'npx --yes vercel@64'

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

function run(label, command) {
  console.log(`\n[deploy:local] ${label}`)
  execSync(command, { cwd: root, stdio: 'inherit' })
}

function fail(message) {
  console.error(`\n[deploy:local] ${message}`)
  process.exit(1)
}

const whoami = capture(`${vercel} whoami`)
if (!whoami || /logged out/i.test(whoami)) {
  fail(
    'Vercel CLI 未登录。请先执行：\n' +
      '  npx vercel login\n' +
      '  npx vercel link\n' +
      '然后重新执行 npm run deploy:local。',
  )
}
console.log(`[deploy:local] Vercel 账号：${whoami}`)

const hasLink = existsSync(resolve(root, '.vercel/project.json'))
const hasEnvLink = Boolean(process.env.VERCEL_ORG_ID && process.env.VERCEL_PROJECT_ID)
if (!hasLink && !hasEnvLink) {
  fail('当前目录还没有关联 Vercel 项目。请先执行：npx vercel link')
}

const dirty = capture('git status --porcelain')
if (dirty) {
  console.warn(
    '\n[deploy:local] 注意：工作区有未提交改动，本次构建会包含这些改动。',
  )
}

try {
  run('拉取生产环境变量与项目配置', `${vercel} pull --yes --environment=production`)
  run('本地构建（不在云端构建）', `${vercel} build --prod --yes`)
  run('上传预构建产物并发布生产', `${vercel} deploy --prebuilt --prod --yes`)
} catch {
  fail('本地构建或发布失败，请查看上方 Vercel CLI 输出。')
}

console.log('\n[deploy:local] 完成：本地构建，预构建产物已发布到生产。')
