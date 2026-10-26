# SEO：为什么 Google 搜不到，以及怎么让它能搜到

## 1. 诊断（改之前）

| 问题 | 说明 |
| --- | --- |
| 没有可索引的文案 | `index.html` 是 `<html lang="en">` + `<title>ticai</title>`，没有 description、keywords、canonical、OG |
| 没有 robots / sitemap | 仓库里没有 `robots.txt`，也没有 `sitemap.xml`，搜索引擎没有入口 |
| 没有提交给 Google | 没有 Search Console 验证，也没有外链；`site:ticai-eight.vercel.app` 查不到任何结果 |
| 纯 SPA | 所有路由都是 `index.html` + React 客户端渲染，Google 能执行 JS，但抓取/渲染有排队延迟，动态赔率页更不稳定 |
| Vercel 域名很新 | `ticai-eight.vercel.app` 没有历史和反向链接，即使收录也很难有排名 |

另外要单独确认：Vercel 项目如果开了 **Deployment Protection → Vercel Authentication**，Googlebot 访问会拿到 401，永远不会收录。这个只能在 Vercel 控制台看，代码里改不了。

## 2. 这次已经补上的

| 文件 | 作用 |
| --- | --- |
| `index.html` | `lang="zh-CN"`；标题、description、keywords、robots、canonical；OG / Twitter 卡片；WebSite + Organization 的 JSON-LD；`<noscript>` 兜底内容与内链 |
| `public/robots.txt` | 允许抓取公开页，屏蔽 `/my-bets`、`/account`、`/login`、`/profile`，并声明 sitemap |
| `public/sitemap.xml` | 7 个公开页面，带 `lastmod`/`changefreq`/`priority` |
| `public/og-cover.png` | 1200×630 分享图（微信 / Twitter / 搜索结果富卡片） |
| `src/features/seo/seo.ts` | 路由级 meta：按 pathname 设置 title、description、canonical、`robots`；私有页自动 `noindex,follow` |
| `src/App.tsx` | 路由变化时调用上面的 `applyPageMeta` |
| `src/pages/MatchDetailPage.tsx` | 比赛详情页用「主队 vs 客队」覆盖标题与描述，canonical 指向 `/match/:id` |
| `src/pages/HomePage.tsx`、`ResultsPage.tsx` | 补了视觉隐藏的 `<h1>`（页面级标题，搜索引擎和读屏软件可见） |
| `vercel.json` | 把 `robots.txt` / `sitemap.xml` / `og-cover.png` 从 SPA 重写里排除，避免被 `index.html` 兜底；补缓存头 |

## 3. 代码之外必须做的（不做等于没优化）

1. **检查部署保护**：Vercel → 项目 `ticai` → Settings → Deployment Protection，Production 不要开启 Vercel Authentication。
2. **Google Search Console**：<https://search.google.com/search-console> 添加资源
   - 推荐「网址前缀」方式 `https://yujun426.online`，用 HTML 标签验证时，把给的 `<meta name="google-site-verification" ...>` 贴到 `index.html` 的 `<head>` 里重新部署；
   - 或「域名」方式，在 Vercel 域名的 DNS 里加 TXT 记录。
3. **提交 sitemap**：GSC → 索引 → 站点地图，填 `sitemap.xml`。
4. **请求编入索引**：GSC → 网址检查，分别对 `/` 和 `/results` 点「请求编入索引」。
5. **Bing Webmaster Tools**：同样提交 sitemap（Bing 收录通常更快，也会同步给其他引擎参考）。
6. **外链**：GitHub 仓库 README、技术博客、相关社群各放一条带链接的介绍。新域名没有外链时，收录周期可能是几天到几周。
7. **自定义域名（可选）**：`*.vercel.app` 可以收录，但独立域名对品牌词和信任度更友好。

## 4. 怎么验证

```bash
# 看 robots 和 sitemap 是否真的以文件返回，而不是 index.html
curl -s https://yujun426.online/robots.txt
curl -s https://yujun426.online/sitemap.xml | head

# 模拟 Googlebot
curl -s -A "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" \
  https://yujun426.online/ | grep -E "<title>|description|canonical"
```

- GSC「网址检查」里看「已渲染的 HTML」是否带 title/description；
- 用 <https://search.google.com/test/rich-results> 检查 JSON-LD；
- 一两周后再查 `site:yujun426.online`。

> 本机对 `*.vercel.app` 的 DNS 被污染（解析到 Facebook IP），本地 `curl` 访问不了属于正常现象，不影响 Google 抓取。

## 5. 预渲染（已实现）

`npm run build` 在 `vite build` 之后会执行 `scripts/prerender.mjs`：

1. 检查本地 API（`127.0.0.1:3001`）是否在线，离线就跳过，不阻断构建；
2. 用 `vite preview` 起一个静态服务（端口 4174），Playwright 逐页打开；
3. 页面里的 `/api/**` 请求被拦截到本地 API（绕开本机对 `*.vercel.app` 的 DNS 污染）；
4. 预置免责声明 localStorage，避免「仅供娱乐」弹层被写进静态 HTML；
5. 等 `networkidle` + 700ms 后落盘：
   - `/` → `dist/prerender/home.html`
   - `/results`、`/history`、`/history-analysis`、`/math-trend-analysis`、`/horoscope`、`/about`
     → `dist/prerender/<name>.html`

`dist/index.html` 保持干净的 SPA 壳（不预渲染），供登录后页面和 `/match/:id` 等动态路由回落，
这样深链不会先闪一下首页内容。

`vercel.json` 用显式 rewrite 把首页和这几条路由指到预渲染文件（`/` → `/prerender/home.html`、
`/results` → `/prerender/results.html`），其余路径仍回落到 SPA 的 `index.html`。
这样 Googlebot 拿到的 HTML 里就有标题、正文数据、canonical，不依赖 JS 渲染；
用户访问时 React 挂载会接管成实时数据。

预渲染是**构建时快照**：数据会停留在构建那一刻。部署频率越高、快照越新；需要刷新时执行 `npm run prerender` 再发布。
比赛详情（`/match/:id`）、登录后页面（`/my-bets` 等）不做预渲染。

## 6. 还可以继续做

1. **按比赛生成静态页**：爬虫跑完后额外产出 `/match/:id` 的静态 HTML，并由 API 提供 `sitemap-matches.xml` 动态 sitemap；
2. **换 SSR 框架**（Next.js / Vike）或 Vercel Edge 中间件动态注入 meta，彻底摆脱构建时快照；
3. **内容策略**：单页工具站很难拿大词，优先做长尾页（联赛页、球队页、每日赛果页），并保持每日更新；
4. **主动提交**：部署后在 GSC 对预渲染页面重新「请求编入索引」，让 Google 拿到新 HTML。
