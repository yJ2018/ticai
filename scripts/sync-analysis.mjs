import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

/**
 * 前端算法 → API/爬虫可用的 ESM。
 *
 * 为什么需要这一步：
 *   - 算法源是 TS（`src/domain/*.ts`），前端由 Vite 打包，浏览器里跑在 Worker 中；
 *   - `apps/api` 是「零构建、上传源码」的部署方式（见 scripts/deploy-api.mjs），
 *     不能 import .ts，也不适合为它引入打包步骤；
 *   - 开奖分析要求「全量样本、开奖后就算一次」，只能放到服务端跑，
 *     所以这里用 tsc 把同一份源做等价翻译，输出到 apps/api/src/analysis/*.mjs。
 *
 * 防漂移：
 *   - 生成内容逐字节可比，`--check` 发现过期就退出 1（pre-commit 会跑）；
 *   - 顺带把源文件指纹写进 generated.mjs，快照表里存下 engineDigest，
 *     事后能回答「这条分析是哪个版本的算法算出来的」。
 *
 *   node scripts/sync-analysis.mjs          重新生成
 *   node scripts/sync-analysis.mjs --check  只校验是否最新
 */

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const OUT_DIR = resolve(root, 'apps/api/src/analysis')

const SOURCES = [
  {
    from: 'src/domain/historyPrediction.ts',
    to: 'apps/api/src/analysis/history-prediction.mjs',
    // 源里是无扩展名相对导入，Node ESM 必须写全
    rewrites: [],
  },
  {
    from: 'src/domain/dltIndicators.ts',
    to: 'apps/api/src/analysis/dlt-indicators.mjs',
    rewrites: [],
  },
  {
    from: 'src/domain/dltRecommendation.ts',
    to: 'apps/api/src/analysis/dlt-recommendation.mjs',
    rewrites: [[/from '\.\/dltIndicators'/g, "from './dlt-indicators.mjs'"]],
  },
]

const checkOnly = process.argv.includes('--check')

function banner(source, digest) {
  return [
    '// ⚠️ 自动生成，不要直接改这个文件。',
    `// 源文件：${source}（算法改动请改 TS，然后 npm run analysis:sync）`,
    `// 生成器：scripts/sync-analysis.mjs · 源指纹 ${digest}`,
    '',
    '',
  ].join('\n')
}

async function transpile(source) {
  const absolute = resolve(root, source.from)
  const text = await readFile(absolute, 'utf8')
  const { outputText } = ts.transpileModule(text, {
    fileName: absolute,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true,
      removeComments: false,
      newLine: ts.NewLineKind.LineFeed,
    },
  })

  let output = outputText
  for (const [pattern, replacement] of source.rewrites) {
    output = output.replace(pattern, replacement)
  }

  return { text, output }
}

async function main() {
  const compiled = []
  for (const source of SOURCES) {
    compiled.push({ ...source, ...(await transpile(source)) })
  }

  const digest = createHash('sha256')
    .update(compiled.map((item) => `${item.from}\n${item.text}`).join('\n'))
    .digest('hex')
    .slice(0, 12)

  const outputs = compiled
    .map((item) => ({ path: item.to, content: banner(item.from, digest) + item.output }))
    .concat({
      path: 'apps/api/src/analysis/generated.mjs',
      content: [
        '// ⚠️ 自动生成，不要直接改这个文件。',
        '// 由 scripts/sync-analysis.mjs 根据 src/domain 下的算法源生成。',
        '',
        `export const ENGINE_DIGEST = '${digest}'`,
        '',
      ].join('\n'),
    })

  const stale = []
  for (const output of outputs) {
    const absolute = resolve(root, output.path)
    const current = await readFile(absolute, 'utf8').catch(() => null)
    // git 在 Windows 上可能把工作区文件转成 CRLF，比较前统一换行符，
    // 否则「只是换了行尾」也会被判成生成物过期
    if (current !== null && current.replace(/\r\n/g, '\n') === output.content) {
      continue
    }
    stale.push(output.path)
    if (!checkOnly) {
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, output.content, 'utf8')
    }
  }

  if (checkOnly) {
    if (stale.length > 0) {
      console.error(
        '[analysis] 生成物与 TS 源不一致：\n' +
          stale.map((path) => `  · ${path}`).join('\n') +
          '\n  请执行 npm run analysis:sync 后重新提交。',
      )
      process.exit(1)
    }
    console.log(`[analysis] 生成物已是最新（源指纹 ${digest}）`)
    return
  }

  if (stale.length === 0) {
    console.log(`[analysis] 无变化（源指纹 ${digest}）`)
    return
  }

  console.log(`[analysis] 已生成 ${stale.length} 个文件（源指纹 ${digest}）`)
  for (const path of stale) {
    console.log(`  · ${path}`)
  }
}

await main()
