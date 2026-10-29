# @ticai/analysis

ticai 的**分析服务**（Python + FastAPI）。所有"分析"类 API 都往这里搬：

| 分析 | 状态 |
| --- | --- |
| 投注推荐（`GET /api/recommendations`） | ✅ 已迁移，与 Node 版对拍通过 |
| 开奖分析 / 数学走势（`/api/analysis/lottery?kind=prediction\|math_trend`） | ✅ 已迁移，全量与夹具对拍 0 差异 |
| 大乐透推演（`kind=dlt`） | ✅ 已迁移，夹具对拍 0 差异 |
| 场馆天气（`/api/venue-weather`） | ✅ 已迁移（DeepSeek 城市解析 + Open-Meteo），本地冒烟通过 |
| 单场 / 串关 AI（`/api/ai-analysis`、`/api/ai-parlay`，SSE） | ✅ 已迁移：提示词逐字节对拍 + 真实 SSE 冒烟通过（`/api/ai-chat` 遗留接口仍在 Node） |

Node API（`apps/api`）通过 `ANALYSIS_API_BASE` 把分析接口反向代理到这里，
浏览器仍然只访问同源 `/api`，前端代码零改动。分析服务不可达时 Node 自动回退内联实现。
代理成功的响应头带 `x-analysis-via: python`（`x-analysis-source` 仍是快照来源，不被覆盖）。

## 目录

```
app/
  main.py            FastAPI 入口（/healthz + 路由挂载）
  config.py          .env / 环境变量读取（本地自动找仓库根 .env）
  db.py              psycopg 连接池（延迟建池，冷启动只建一次）
  errors.py          AnalysisError → {success:false,errorMessage}
  recommend/
    mathx.py         泊松 / Dixon-Coles / 幂法去水 / λ 反推（纯函数）
    odds.py          赔率 jsonb → 数值 + 组内去水 + 选项文案
    data.py          只读 SQL（在售盘口、伤停、历史战绩、回测样本）
    engine.py        推荐引擎：有界修正 + 融合 + 单关/2串1/3串1 风控
    backtest.py      同口径回测（单场首选 / 2串1 / 长赔 / 赔率区间）
  analysis/
    prediction.py    位置型预测（频次/遗漏/转移/马尔可夫/滚动回测）+ 数学走势（增量流式，全量 7762 期 1.6s）
    dlt.py           大乐透 5+2 推演（评分池 + 组合打分 + 可解释理由）
    dlt_indicators.py 和值/跨度/奇偶/大小/三区指标
    configs.py       config_key 指纹与预设组合（与 Node 字符串完全一致）
    compute.py       读开奖 → 算 → 写快照（与 Node 同一张表）
  llm.py             DeepSeek 客户端（非流式 + SSE 流式，OpenAI 兼容，标准库 urllib）
  venue.py           比赛地天气（DeepSeek 解析城市 + Open-Meteo 预报）
  ratelimit.py       滑动窗口限流
  ai/
    prompt.py          单场分析提示词（5 种玩法、官方数据、天气，逐字节对齐 Node）
    context.py         比赛 + 赔率 + feed + 阵容 + 天气（天气最多等 5s）
    parlay_prompt.py   串关提示词（逐场审视 + 缓存分析复用）
    parlay_context.py  串关一次取齐 3 条 SQL
  routes/
    recommend.py     GET /api/recommendations（60s 缓存，回测 10min）
    lottery.py       GET /api/analysis/lottery（支持 `order=` 与 `w=` 自定义权重）、/api/analysis/lottery/snapshots
    weather.py       GET /api/venue-weather（按 IP 限流）
    ai.py            POST /api/ai-analysis、/api/ai-parlay（SSE：meta/reasoning/content/done/error）
api/index.py         Vercel 函数入口（暴露 ASGI app）
tests/               单测 + 与 Node 引擎的对拍（同一批夹具）
```

## 本地开发

```bash
# 一次性：建虚拟环境（Python 3.12）
python -m venv apps/analysis/.venv
apps/analysis/.venv/Scripts/pip install -r apps/analysis/requirements.txt

# 起服务（读仓库根 .env 的 DATABASE_URL）
npm run analysis:dev          # http://127.0.0.1:3012

# 让 Node API 走 Python
ANALYSIS_API_BASE=http://127.0.0.1:3012 npm run api:dev

# 测试（单测 + 对拍）
npm run analysis:test

# 重新导出对拍夹具（赔率会变，夹具是快照）
npm run analysis:fixtures
```

## 与 Node 版的约定

- **接口形状完全一致**：同一个路径、同样的 `{success, data}` 信封、同样的字段名，
  前端与 Node 代理都不用判断"这是谁算的"（响应头 `x-analysis-via: python` 只用于排查；
  `x-analysis-source` 仍是开奖快照来源，不被覆盖）。
- **对拍**：`npm run analysis:fixtures` 用 Node 引擎导出同一批盘口/开奖的期望结果，
  `npm run analysis:test` 里 Python 必须给出同样的方案与选腿，概率差 < 5e-3。
  开奖分析实测全量 7762 期逐字段 **0 差异**；推荐最大差 5e-4（来自 λ 粗网格的浮点求和顺序）。
- **回滚**：线上把 `ANALYSIS_API_BASE` 删掉就回到 Node 内联实现，不需要回滚代码。

## 部署

```bash
# 首次：建 Vercel 项目（或在 Vercel 控制台建好后设置 ANALYSIS_PROJECT_ID）
cd apps/analysis && npx vercel link --yes --project ticai-analysis

npm run deploy:analysis
```

- Vercel 项目：`ticai-analysis`（Python 运行时，`requirements.txt` 由 Vercel 安装）。
- 必配环境变量：`DATABASE_URL`、`DATABASE_SSL`（云库设 1）、`DEEPSEEK_API_KEY`（天气城市解析 + AI 分析）；
  本地 `.env` 不会上传，`npm run deploy:analysis` 只上传 `api/ app/ requirements.txt vercel.json`。
- 发布后在 **Node API 项目**（`ticai-service`）设置 `ANALYSIS_API_BASE=https://ticai-analysis.vercel.app`，
  分析接口才会走 Python。
- **必须关掉 Deployment Protection**（Vercel 项目 → Settings → Deployment Protection → Vercel Authentication 关），
  否则 Node 代理请求会被 401 挡住、只能回退内联实现。

### Vercel rewrite 的路径还原（踩过的坑）

Vercel 把 `/(.*)` rewrite 到函数后，函数里看到的 `path` 就是 `/api/index`，**原始路径完全丢失**
（`destination` 写 `/api` 或 `/api/index` 都一样）。所以：

- `vercel.json` 用 `destination: "/api/index?__path=/$1"` 把原路径带进查询串（其它查询参数 Vercel 会保留）；
- `app/main.py` 的 `RewritePathMiddleware` 在 ASGI 层把 `__path` 还原成 `scope["path"]` 并摘掉它；
- 回归测试见 `tests/test_middleware.py`（4 个用例，含 header 兜底与放行分支）。

### 线上验证

```bash
# 1) 直连分析服务（本机 DNS 可能把 *.vercel.app 解析错，失败就以浏览器为准）
curl -s https://ticai-analysis.vercel.app/healthz

# 2) 走生产链路（前端域名 → Next rewrite → ticai-service → Python）
#    看到 x-analysis-via: python 才说明真的走了 Python
curl -sI 'https://yujun426.online/api/analysis/lottery?game=pl5&kind=prediction&order=2' | grep -i x-analysis

# 3) 自定义权重（默认权重会被规范成 markov=2，不带 ;w=）
curl -s 'https://yujun426.online/api/analysis/lottery?game=pl5&kind=prediction&order=3&w=60-20-22-14-10' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).data.configKey))"
```
