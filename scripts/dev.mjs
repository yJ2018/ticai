import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const viteBin = resolve(root, 'node_modules/vite/bin/vite.js')

if (!existsSync(viteBin)) {
  console.error('[dev] 找不到 vite，请先执行 npm install')
  process.exit(1)
}

const children = new Map()
let exiting = false

function start(name, args) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env })

  child.on('error', (error) => {
    console.error(`[dev] 无法启动 ${name}：${error.message}`)
  })

  child.on('exit', (code, signal) => {
    children.delete(name)
    if (exiting) {
      return
    }
    exiting = true
    console.log(`\n[dev] ${name} 已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}），关闭其余进程...`)
    for (const other of children.values()) {
      other.kill()
    }
    process.exit(code ?? 0)
  })

  children.set(name, child)
  return child
}

function shutdown(signal) {
  if (exiting) {
    return
  }
  exiting = true
  console.log(`\n[dev] 收到 ${signal}，正在关闭...`)
  for (const child of children.values()) {
    child.kill()
  }
  setTimeout(() => process.exit(0), 300).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

console.log('[dev] 启动 API（apps/api）与 Vite 开发服务器...')
start('api', ['apps/api/src/index.mjs'])
start('web', [viteBin, '--host'])
