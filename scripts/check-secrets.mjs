import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 提交前扫描 staged 文件里的疑似密钥。
 * 由 .git/hooks/pre-commit 调用，也可以手动执行 npm run check:secrets。
 */

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

const RULES = [
  { label: 'DeepSeek/OpenAI API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { label: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { label: 'Vercel token', pattern: /\bvercel_[A-Za-z0-9]{20,}\b/ },
  { label: 'Juhe key', pattern: /\bJUHE_[A-Z_]*(?:KEY|SECRET)\s*=\s*[0-9a-fA-F]{16,}/ },
  {
    label: 'Secret assignment',
    pattern: /\b(?:API_KEY|APIKEY|SECRET|TOKEN|PASSWORD)\s*[:=]\s*['"][^'"]{12,}['"]/i,
  },
]

const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'])

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
}

function mask(value) {
  if (value.length <= 12) {
    return `${value.slice(0, 3)}…`
  }
  return `${value.slice(0, 8)}…${value.slice(-4)} (${value.length} chars)`
}

let stagedFiles
try {
  const output = git(['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z'])
  stagedFiles = output.split('\0').filter(Boolean)
} catch (error) {
  console.error('[check-secrets] 无法读取暂存区：', error instanceof Error ? error.message : String(error))
  process.exit(0)
}

const findings = []

for (const file of stagedFiles) {
  if (SKIP_FILES.has(file)) {
    continue
  }

  let content
  try {
    content = git(['show', `:${file}`])
  } catch {
    continue
  }

  if (content.includes('\0')) {
    continue
  }

  const lines = content.split(/\r?\n/)
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      const match = line.match(rule.pattern)
      if (match) {
        findings.push({
          file,
          line: index + 1,
          label: rule.label,
          preview: mask(match[0]),
        })
        break
      }
    }
  })
}

if (findings.length === 0) {
  console.log('[check-secrets] 未发现疑似密钥。')
  process.exit(0)
}

console.error(`[check-secrets] 发现 ${findings.length} 处疑似密钥，已阻止提交：\n`)
for (const finding of findings) {
  console.error(`  ${finding.file}:${finding.line}  ${finding.label}  ${finding.preview}`)
}
console.error('\n真实密钥请只放在 .env（已被 .gitignore 忽略），不要提交。')
console.error('如确认是误报，可使用 git commit --no-verify 跳过（不推荐）。')
process.exit(1)
