import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { withTransaction } from '../src/db.mjs'

/**
 * 借出连接的 error 监听回归测试。
 *
 * 2026-11-03 常驻爬虫停更一天：matches 跨境写库撞上 ECONNRESET，
 * 借出中的 pg Client emit('error') 没有监听器，Node 按未捕获异常把进程带走。
 * 这里用假 Client 复现「连接被断开」那一刻，确认不会再抛到进程层。
 */

function fakeClient({ rollbackFails = false } = {}) {
  const client = new EventEmitter()
  client.queries = []
  client.released = null
  client.query = async (sql) => {
    client.queries.push(sql)
    if (sql === 'rollback' && rollbackFails) {
      throw new Error('connection terminated')
    }
    return { rows: [], rowCount: 0 }
  }
  client.release = (error) => {
    client.released = error ?? null
  }
  return client
}

function silent(fn) {
  const original = console.error
  console.error = () => {}
  return Promise.resolve(fn()).finally(() => {
    console.error = original
  })
}

test('withTransaction: 借出的连接挂上 error 监听，ECONNRESET 不会带走进程', async () => {
  const client = fakeClient()
  const pool = { connect: async () => client }

  const result = await silent(async () => {
    const value = await withTransaction(pool, async () => 'ok')
    assert.equal(value, 'ok')
    assert.equal(client.listenerCount('error'), 1)
    // 没有监听器时 EventEmitter 会同步 throw，这一步就是原来的崩溃点
    assert.doesNotThrow(() => client.emit('error', new Error('read ECONNRESET')))
    return value
  })

  assert.equal(result, 'ok')
  assert.equal(client.released, null, '正常提交后应无参归还连接')
})

test('withTransaction: 回滚也失败时用 release(error) 销毁坏连接', async () => {
  const client = fakeClient({ rollbackFails: true })
  const pool = { connect: async () => client }

  await silent(async () => {
    await assert.rejects(() => withTransaction(pool, async () => {
      throw new Error('UPSERT match 失败')
    }), /UPSERT match 失败/)
  })

  assert.ok(client.released instanceof Error, '坏连接不能放回池里')
  assert.match(client.released.message, /UPSERT match 失败/)
})

test('withTransaction: 普通失败回滚后照常归还连接', async () => {
  const client = fakeClient()
  const pool = { connect: async () => client }

  await silent(async () => {
    await assert.rejects(() => withTransaction(pool, async () => {
      throw new Error('约束冲突')
    }), /约束冲突/)
  })

  assert.deepEqual(client.queries, ['begin', 'rollback'])
  assert.equal(client.released, null)
  assert.equal(client.listenerCount('error'), 1, '每个 Client 只挂一次监听')
})
