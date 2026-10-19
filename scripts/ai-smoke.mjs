import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HttpError, loadEnvFile } from '../server/lib.mjs'
import { chatCompletion, createLlmConfig } from '../server/llm.mjs'

/**
 * 密钥连通性自检：绕过 BFF，直接用 server/llm.mjs 调一次 DeepSeek。
 * 用法：npm run ai:check [提示词]
 */

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
loadEnvFile(resolve(root, '.env'))

const config = createLlmConfig()

if (!config.apiKey) {
  console.error('[ai:check] 未找到 DEEPSEEK_API_KEY。')
  console.error(`          请在 ${resolve(root, '.env')} 中填写：DEEPSEEK_API_KEY=sk-...`)
  process.exit(1)
}

const prompt = process.argv.slice(2).join(' ').trim() || '请用一句话介绍你自己。'

console.log(`[ai:check] 上游：${config.baseUrl}`)
console.log(`[ai:check] 模型：${config.model}  思考模式：${config.thinking ? '开启' : '关闭'}`)
console.log(`[ai:check] 提示词：${prompt}`)

const startedAt = Date.now()

try {
  const result = await chatCompletion(config, {
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 256,
  })

  console.log(`\n${result.content.trim() || '(空回复)'}\n`)
  console.log(
    `[ai:check] 成功 · ${Date.now() - startedAt}ms · tokens ` +
      `prompt=${result.usage.promptTokens} completion=${result.usage.completionTokens} total=${result.usage.totalTokens}`,
  )
  if (result.truncated) {
    console.warn('[ai:check] 注意：输出达到 max_tokens 上限被截断。')
  }
} catch (error) {
  if (error instanceof HttpError) {
    console.error(`\n[ai:check] 失败（HTTP ${error.status}）：${error.message}`)
  } else {
    console.error('\n[ai:check] 失败：', error)
  }
  process.exit(1)
}
