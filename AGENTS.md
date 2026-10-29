# AGENTS.md · ticai 交付约定

本文件是仓库级操作约定，适用于所有后续开发会话。

## push 前自动流程

1. 运行 `npm run architecture:update`（`pre-commit` hook 也会自动执行），同步：
   - `docs/architecture.svg`
   - `docs/architecture.png`
2. 若本次改动涉及行为、数据流、接口或模块职责变化，手动补充 `docs/architecture.md` 的 Mermaid / 文字说明，不能只依赖自动文件清单图。
3. 运行 `npm run build` 和 `npm run check:secrets`。
4. 提交后执行 `git push`；`pre-push` hook 会对 `main` 自动发布**前端与 API**（`npm run deploy`），两端都进 Vercel 生产环境。
5. 用户说"部署"时，默认按 `npm run deploy` 处理：前端、API 都要发，不能只发一个。

## Git hooks

- hook 源文件在 `scripts/git-hooks/`，跨机器克隆后执行一次 `npm run hooks:install`。
- `pre-commit`：先生成架构图，再扫描 staged 密钥。
- `pre-push`：
  - 依次执行 `deploy-local.mjs`（前端）与 `deploy-api.mjs`（API）；
  - `SKIP_DEPLOY=1 git push` 跳过本次部署；
  - `DEPLOY_STRICT=1 git push` 部署失败时阻止推送；
  - 默认部署失败仍继续推送，并提示手动重试 `npm run deploy`。
- 部署脚本使用临时目录 + `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`，不依赖仓库根 `.vercel`；需要本机已执行 `npx vercel login`。
- 前端发布：`deploy-local.mjs` 本地 `next build` 自检 → 上传前端源码 → Vercel 远端构建（不走 `vercel build --prebuilt`：它在本机会再 spawn 一层 shell，受限环境直接失败）；`/api/**` 由 `next.config.ts` rewrite 到 `ticai-service`。
- API 发布：`deploy-api.mjs` 上传 `apps/api` 源码，发布后尽力探 `/healthz` 与 `/api/matches`（本机 DNS 被污染时只告警）。
- 分析服务发布：`deploy-analysis.mjs` 上传 `apps/analysis`（Python / FastAPI）到 Vercel 项目 `ticai-analysis`；
  首次需先建项目（`cd apps/analysis && npx vercel link --yes --project ticai-analysis`，或设 `ANALYSIS_PROJECT_ID`），
  并配好 `DATABASE_URL` / `DATABASE_SSL` / `DEEPSEEK_API_KEY`。
  **项目必须关掉 Deployment Protection（Vercel Authentication）**，否则 Node 代理会被 401 挡住。
  Vercel rewrite 会丢掉原始路径，`vercel.json` 用 `?__path=/$1` + `app/main.py` 的 `RewritePathMiddleware` 还原，
  改动这段逻辑必须跑 `npm run analysis:test`（含 4 个中间件用例）。
  发布后在 `ticai-service` 设置 `ANALYSIS_API_BASE=https://ticai-analysis.vercel.app`，分析接口才会走 Python；
  未配置时 Node 内联实现照常工作，删掉该变量即可回滚。分析服务测试：`npm run analysis:test`。

## 仓库结构

- `apps/api`：独立服务端（只读库，REST + SSE），部署在 Vercel 项目 `ticai-service`。
- `apps/analysis`：Python 分析服务（FastAPI），部署在 Vercel 项目 `ticai-analysis`；入口 `api/index.py`，
  推荐逻辑在 `app/recommend/`，通过 `npm run analysis:fixtures` 生成的对拍夹具与 Node 版保持一致。
- `apps/crawler`：本地爬虫（只写库），`npm run crawl:daemon` 常驻；受竞彩销售时段闸门约束。
- `db/`：迁移与保留策略，`npm run db:migrate` 执行。
- 前端是 **Next.js 16 App Router**（`src/app`），部署在 Vercel 项目 `ticai`；页面外壳在根 layout（Keep-Alive 依赖它跨路由不卸载），路由清单在 `src/router/manifest.ts`。
- 前端与 API 同源：`next.config.ts` 的 rewrite 把 `/api/**` 转到 `ticai-service`（本地转到 3001），浏览器 bundle 里不写死域名。
- `src/views/` 是页面组件（不是 Next 的 Pages Router）；`src/pages/` 这个目录名会和 Next 冲突，不要再建。
- 前端发布：`deploy-local.mjs` 先本地 `next build` 自检，再把前端源码暂存上传，由 Vercel 远端构建（不走 `vercel build --prebuilt`，本机受限环境会失败）；`.env*` 与 `apps/`、`db/`、`scripts/` 不上传。

## 架构图

- 自动图只反映目录、文件清单和静态分层；语义变化（新增链路、缓存策略、接口契约）必须同步更新 `docs/architecture.md`。
- 图片优先使用 `architecture.svg`；`architecture.png` 由本机 Edge/Chrome 渲染，缺失浏览器时会保留旧 PNG，但不会阻止提交。
