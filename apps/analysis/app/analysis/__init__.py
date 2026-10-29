"""开奖分析的编排层（对齐 apps/api/src/analysis/compute.mjs）。

数据流：lottery_draw（全量） → analyze*（全量样本） → lottery_analysis_snapshot（含溯源）
"""
