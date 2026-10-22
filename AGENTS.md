# AGENTS.md · ticai 交付约定

本文件是仓库级操作约定，适用于所有后续开发会话。

## push 前自动流程

1. 运行 `npm run architecture:update`（`pre-commit` hook 也会自动执行），同步：
   - `docs/architecture.svg`
   - `docs/architecture.png`
2. 若本次改动涉及行为、数据流、接口或模块职责变化，手动补充 `docs/architecture.md` 的 Mermaid / 文字说明，不能只依赖自动文件清单图。
3. 运行 `npm run build` 和 `npm run check:secrets`。
4. 提交后执行 `git push`；`pre-push` hook 会对 `main` 自动执行 `npm run deploy:local`，发布 Vercel 生产环境。

## Git hooks

- hook 源文件在 `scripts/git-hooks/`，跨机器克隆后执行一次 `npm run hooks:install`。
- `pre-commit`：先生成架构图，再扫描 staged 密钥。
- `pre-push`：
  - `SKIP_DEPLOY=1 git push` 跳过本次部署；
  - `DEPLOY_STRICT=1 git push` 部署失败时阻止推送；
  - 默认部署失败仍继续推送，并提示手动重试 `npm run deploy:local`。
- 部署脚本使用临时目录 + `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`，不依赖仓库根 `.vercel`；需要本机已执行 `npx vercel login`。
- 发布构建会用 `VITE_API_BASE`（默认 `https://ticai-service.vercel.app`）并校验 bundle 中存在该地址；前端只连自有 API，体彩由本地爬虫访问（云厂商出口 IP 会被 WAF 拦截）。

## 仓库结构

- `apps/api`：独立服务端（只读库，REST + SSE），部署在 Vercel 项目 `ticai-service`。
- `apps/crawler`：本地爬虫（只写库），`npm run crawl:daemon` 常驻；受竞彩销售时段闸门约束。
- `db/`：迁移与保留策略，`npm run db:migrate` 执行。
- 前端静态托管在 Vercel 项目 `ticai`，通过 `VITE_API_BASE` 指向 API；`server/` 与 `api/` 已删除。

## 架构图

- 自动图只反映目录、文件清单和静态分层；语义变化（新增链路、缓存策略、接口契约）必须同步更新 `docs/architecture.md`。
- 图片优先使用 `architecture.svg`；`architecture.png` 由本机 Edge/Chrome 渲染，缺失浏览器时会保留旧 PNG，但不会阻止提交。
