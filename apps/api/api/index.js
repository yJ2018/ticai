import { createApp } from '../src/app.mjs'
import { createConfig } from '../src/config.mjs'

/**
 * Vercel Serverless 入口。
 *
 * 与本地入口共用同一份 createApp()，只是宿主换成 Vercel 的 (req, res)。
 * 环境变量来自 Vercel 项目设置，不读 .env。
 *
 * 部署时把项目的 Root Directory 指到 apps/api，vercel.json 负责把
 * 所有路径重写到这个函数。
 */

const app = createApp(createConfig())

export default function handler(req, res) {
  return app(req, res)
}
