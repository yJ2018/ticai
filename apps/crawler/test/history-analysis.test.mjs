import assert from 'node:assert/strict'
import test from 'node:test'

import { refreshAnalysis } from '../src/tasks/history.mjs'

/**
 * 开奖入库 → 分析快照这条钩子的契约：
 *   1. 没有写库就不算（省掉一次没必要的查询）；
 *   2. 算不出来不能让一次成功的抓取变成失败（返回 error 字段而不是抛错）。
 */

const GAME = { gameKey: 'pl5', gameNo: '350133', name: '排列5', mainCount: 5, extraCount: 0 }

function collectLogs() {
  const logs = []
  return { logs, log: (message) => logs.push(String(message)) }
}

test('refreshAnalysis: saved=0 时直接跳过，不碰数据库', async () => {
  let calls = 0
  const pool = {
    query: async () => {
      calls += 1
      return { rows: [] }
    },
  }
  const { log } = collectLogs()

  const result = await refreshAnalysis({ pool, game: GAME, saved: 0, runId: 1, log })

  assert.deepEqual(result, { computed: 0, skipped: 0 })
  assert.equal(calls, 0)
})

test('refreshAnalysis: 分析失败只告警，不抛错（抓取本身已经成功）', async () => {
  const pool = {
    // 第一枪就失败：等价于「库里没有这个彩种」或网络抖动
    query: async () => {
      throw new Error('数据库连接超时')
    },
  }
  const { logs, log } = collectLogs()

  const result = await refreshAnalysis({ pool, game: GAME, saved: 3, runId: 7, log })

  assert.equal(result.computed, 0)
  assert.match(result.error, /数据库连接超时/)
  assert.ok(
    logs.some((line) => line.includes('分析快照失败') && line.includes('不影响开奖入库')),
    `应留下告警日志，实际：${logs.join(' | ')}`,
  )
})

test('refreshAnalysis: 样本不足（没有开奖行）时不写快照', async () => {
  const game = { ...GAME }
  const pool = {
    query: async (text) => {
      const sql = String(text).replace(/\s+/g, ' ').trim()
      if (sql.includes('from lottery_game')) {
        return {
          rows: [
            {
              game_no: game.gameNo,
              game_key: game.gameKey,
              name: game.name,
              is_positional: true,
              digit_count: 5,
              main_count: 5,
              extra_count: 0,
            },
          ],
        }
      }
      if (sql.includes('from lottery_draw')) {
        return { rows: [] }
      }
      throw new Error(`不该执行：${sql.slice(0, 40)}`)
    },
  }
  const { log } = collectLogs()

  const result = await refreshAnalysis({ pool, game, saved: 1, runId: 9, log })

  assert.deepEqual(result, { computed: 0, skipped: 0 })
})
