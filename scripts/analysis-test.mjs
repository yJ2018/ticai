/** 跑分析服务（Python）的测试：node scripts/analysis-test.mjs [--pattern xxx] */

import { spawnSync } from 'node:child_process'

import { analysisRoot, findPython } from './analysis-python.mjs'

const python = findPython()
const root = analysisRoot()
const extra = process.argv.slice(2)

const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests', '-t', '.', '-v', ...extra], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})

if (result.error) {
  console.error(`[analysis:test] 无法启动 Python（${python}）：${result.error.message}`)
  console.error('  先建虚拟环境：python -m venv apps/analysis/.venv && apps/analysis/.venv/Scripts/pip install -r apps/analysis/requirements.txt')
  process.exit(1)
}

process.exit(result.status ?? 1)
