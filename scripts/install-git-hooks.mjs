import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceDir = resolve(root, 'scripts/git-hooks')
const targetDir = resolve(root, '.git/hooks')

if (!existsSync(resolve(root, '.git'))) {
  console.error('[hooks] 当前目录不是 Git 仓库，无法安装 hooks。')
  process.exit(1)
}

mkdirSync(targetDir, { recursive: true })

for (const name of ['pre-commit', 'pre-push']) {
  const target = resolve(targetDir, name)
  copyFileSync(resolve(sourceDir, name), target)
  try {
    chmodSync(target, 0o755)
  } catch {
    // Windows 上 chmod 可能无效，Git for Windows 仍会按 sh 执行 hook。
  }
  console.log(`[hooks] 已安装 .git/hooks/${name}`)
}

console.log('[hooks] 完成：提交前同步架构图，推送到 main 前自动部署。')
