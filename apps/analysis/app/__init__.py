"""ticai 分析服务（Python 版）。

职责：把所有"分析"类接口从 Node 的 apps/api 搬到这里——
投注推荐（本期）、开奖分析/走势/回测、场馆天气、AI 单场/串关（后续回合）。

Node API 通过 `ANALYSIS_API_BASE` 反向代理到这里，浏览器仍然只访问同源 /api。
"""
