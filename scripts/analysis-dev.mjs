/** 本地起分析服务：node scripts/analysis-dev.mjs [--port 3012] */

import { spawn } from 'node:child_process'

import { analysisRoot, findPython } from './analysis-python.mjs'

const python = findPython()
const root = analysisRoot()

const portIndex = process.argv.indexOf('--port')
const port = portIndex > -1 ? process.argv[portIndex + 1] : process.env.ANALYSIS_PORT || '3012'

console.log(`[analysis:dev] ${python} -m uvicorn app.main:app --port ${port}`)
const child = spawn(
  python,
  ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)],
  { cwd: root, stdio: 'inherit', env: process.env },
)

child.on('exit', (code) => process.exit(code ?? 0))
process.on('SIGINT', () => child.kill('SIGINT'))
