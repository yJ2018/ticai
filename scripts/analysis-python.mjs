/** 找到分析服务的 Python 解释器。
 *
 *  1. `ANALYSIS_PYTHON` 环境变量（CI / 自定义 venv）；
 *  2. `apps/analysis/.venv`（本地 `python -m venv apps/analysis/.venv`）；
 *  3. 系统 `python` / `python3`。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

const candidates = [
  process.env.ANALYSIS_PYTHON,
  resolve(root, 'apps/analysis/.venv/Scripts/python.exe'),
  resolve(root, 'apps/analysis/.venv/bin/python'),
]

export function findPython() {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate
    }
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}

export function analysisRoot() {
  return resolve(root, 'apps/analysis')
}
