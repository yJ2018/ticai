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
| `src/app/layout.tsx` | `lang="zh-CN"`；站点级 title / description / keywords / OG / Twitter、机器人图标（favicon.ico / 32 / apple-touch / 192 / 512）、WebSite + Organization 的 JSON-LD |
| `src/app/[[...slug]]/page.tsx` | 页面级 `generateMetadata`：title、description、canonical、robots、OG；未知路径 `notFound()` |
| `public/robots.txt` | 允许抓取公开页，屏蔽 `/my-bets`、`/account`、`/login`、`/auth/`、`/profile`，并声明 sitemap |
| `public/sitemap.xml` | 8 个公开页面，带 `lastmod`/`changefreq`/`priority` |
| `public/og-cover.png` | 1200×630 分享图（微信 / Twitter / 搜索结果富卡片） |
| `src/features/seo/seo.ts` | `resolvePageMeta()` 纯函数：按 pathname 产出 title / description / canonical / `robots`；私有页自动 `noindex,follow`。服务端与客户端共用 |
| `src/App.tsx` | 客户端导航后调用 `applyPageMeta`（首屏 meta 已由服务端给出） |
| `src/views/MatchDetailPage.tsx` | 比赛详情页用「主队 vs 客队」覆盖标题与描述，canonical 指向 `/match/:id` |
| `src/views/HomePage.tsx`、`ResultsPage.tsx` | 补了视觉隐藏的 `<h1>`（页面级标题，搜索引擎和读屏软件可见） |
| `next.config.ts` | `/api/**` rewrite 到 API 项目；`public/` 下的静态文件由 Next 直接返回，不进 rewrite |

## 3. 代码之外必须做的（不做等于没优化）

1. **检查部署保护**：Vercel → 项目 `ticai` → Settings → Deployment Protection，Production 不要开启 Vercel Authentication。
2. **Google Search Console**：<https://search.google.com/search-console> 添加资源
   - 推荐「网址前缀」方式 `https://yujun426.online`，用 HTML 标签验证时，把 `<meta name="google-site-verification" ...>` 写进 `src/app/layout.tsx` 的 `metadata.verification.google`，重新部署；
   - 或「域名」方式，在 Vercel 域名的 DNS 里加 TXT 记录。
3. **提交 sitemap**：GSC → 索引 → 站点地图，填 `sitemap.xml`。
4. **请求编入索引**：GSC → 网址检查，分别对 `/` 和 `/results` 点「请求编入索引」。
5. **Bing Webmaster Tools**：同样提交 sitemap（Bing 收录通常更快，也会同步给其他引擎参考）。
6. **外链**：GitHub 仓库 README、技术博客、相关社群各放一条带链接的介绍。新域名没有外链时，收录周期可能是几天到几周。
7. **自定义域名（已完成）**：2026-10-26 起绑定 `yujun426.online`，canonical / OG / robots / sitemap 已全部切换；`*.vercel.app` 仍可访问但不作为 canonical。

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

## 5. SSR（已实现，取代原预渲染）

前端已从「构建时预渲染」改成 **Next.js 16 App Router 按请求渲染**：

1. 每个页面请求由 `src/app/[[...slug]]/page.tsx`（Server Component）处理，未知路径直接 `notFound()` → 真 404；
2. `generateMetadata()` 产出 title / description / canonical / robots / OG，与客户端导航共用 `resolvePageMeta()` 同一份规则；
3. 根布局 `src/app/layout.tsx` 输出站点级 metadata、图标与 JSON-LD，并挂载客户端外壳 `AppShell`；
4. 不再依赖本机 Chrome 与本地 API，也没有「构建时快照」——数据跟着 API 走。

现状边界：

- **首页**已经服务端预取比赛列表：原始 HTML 里就有 14 场比赛的队名与赔率（约 94 KB，gzip 12.6 KB），
  Googlebot 不执行 JS 也能读到内容；
- **赛果开奖页 `/results`** 同样预取了当天赛果（10 条已开奖比赛 + 五个玩法结果，约 32 KB）；
- `/about` 是完整服务端正文，各页 title / canonical / robots 都由服务端产出；
- `/history`、两个分析页仍是客户端取数，只是 meta 正确；
- 比赛详情 `/match/:id` 是 SSR 路由（200/404 正确），正文依赖客户端取数。

## 6. 还可以继续做

1. **服务端预取列表数据**：在服务端先取一次 matches / results / history，再随 HTML 下发（见 architecture.md §13.5 的架构约束）；
2. **比赛详情长尾页**：由 API 提供 `sitemap-matches.xml` 动态 sitemap，把当天在售比赛暴露给爬虫；
3. **内容策略**：单页工具站很难拿大词，优先做长尾页（联赛页、球队页、每日赛果页），并保持每日更新；
4. **主动提交**：部署后在 GSC 对公开页「请求编入索引」，让 Google 拿到新 HTML。
