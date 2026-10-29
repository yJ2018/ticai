"""推荐逻辑的回测（对齐 apps/api/src/recommend/backtest.mjs）。

口径与线上推荐保持一致：拿**开赛前最后一次**赔率快照去水 → 选「市场概率最高且赔率在带内」
的选项。这里刻意不引入任何赛后信息，也不为某几场特例调参——回测是用来给用户看
「这套口径大概什么水平」的，不是用来证明自己准。

同时给出三组对照：
  - 长赔（每场挑赔率最高的一项）：证明冷门的长期期望；
  - 赔率区间命中率：解释为什么推荐把赔率压在 3.3 以下；
  - 2串1 模拟：把相邻两场的首选串起来，看看串关后的真实命中率与回报。
"""

from __future__ import annotations

from .odds import market_probabilities, read_pools

SAFE_TIER = {"marketP": 0.42, "minOdd": 1.25, "maxOdd": 2.15}
WIDE_TIER = {"marketP": 0.36, "minOdd": 1.25, "maxOdd": 2.45}

BANDS = (
    {"label": "1.25–1.60", "min": 1.25, "max": 1.6},
    {"label": "1.60–2.00", "min": 1.6, "max": 2.0},
    {"label": "2.00–2.60", "min": 2.0, "max": 2.6},
    {"label": "2.60–3.40", "min": 2.6, "max": 3.4},
    {"label": "3.40–5.00", "min": 3.4, "max": 5.0},
    {"label": "5.00 以上", "min": 5.0, "max": float("inf")},
)

BACKTEST_NOTE = (
    "回测只用开赛前最后一次赔率快照，按「市场概率最高 + 赔率 1.25–2.15」选场；不含任何赛后信息。"
    "样本只有几天，波动很大，只用来对比高赔与低赔的相对水平，不代表长期收益。"
)


def summarize(rows: list[dict]) -> dict:
    if not rows:
        return {"n": 0, "hits": 0, "hitRate": 0.0, "roi": 0.0, "avgOdd": 0.0}
    hits = sum(1 for row in rows if row["hit"])
    profit = sum(row["odd"] - 1 if row["hit"] else -1 for row in rows)
    return {
        "n": len(rows),
        "hits": hits,
        "hitRate": round(hits / len(rows), 4),
        "roi": round(profit / len(rows), 4),
        "avgOdd": round(sum(row["odd"] for row in rows) / len(rows), 3),
    }


def _in_tier(candidate: dict, tier: dict) -> bool:
    return (
        candidate["marketP"] >= tier["marketP"]
        and candidate["odd"] >= tier["minOdd"]
        and candidate["odd"] <= tier["maxOdd"]
    )


def run_backtest(samples: list[dict]) -> dict:
    usable: list[dict] = []
    option_rows: list[dict] = []
    longshot_rows: list[dict] = []

    for sample in samples:
        pools = read_pools(sample.get("odds"))
        market = market_probabilities(pools)
        if not market["had"] or not sample.get("hadResult"):
            continue
        usable.append(sample)

        options = [
            {"key": key, "odd": pools["had"][key], "marketP": market["had"][key]}
            for key in ("h", "d", "a")
        ]
        options = [option for option in options if option["odd"] > 1 and option["marketP"] > 0]

        if len(options) < 3:
            continue

        for option in options:
            option_rows.append(
                {"odd": option["odd"], "hit": option["key"] == sample["hadResult"], "kickoffAt": sample["kickoffAt"]}
            )

        favourite = sorted(options, key=lambda option: option["marketP"], reverse=True)[0]
        longest = sorted(options, key=lambda option: option["odd"], reverse=True)[0]
        if longest["odd"] >= 4:
            longshot_rows.append({"odd": longest["odd"], "hit": longest["key"] == sample["hadResult"]})

        sample["__favourite"] = favourite

    safe_picks: list[dict] = []
    wide_picks: list[dict] = []
    for sample in usable:
        favourite = sample.get("__favourite")
        if not favourite:
            continue
        hit = favourite["key"] == sample["hadResult"]
        row = {"odd": favourite["odd"], "hit": hit, "kickoffAt": sample["kickoffAt"], "matchId": sample["matchId"]}
        if _in_tier(favourite, SAFE_TIER):
            safe_picks.append(row)
        elif _in_tier(favourite, WIDE_TIER):
            wide_picks.append(row)

    # 2串1：按开赛时间相邻两两配对（同一注只覆盖两场）
    ordered = sorted(safe_picks, key=lambda row: row["kickoffAt"] or "")
    doubles = []
    for index in range(0, len(ordered) - 1, 2):
        first, second = ordered[index], ordered[index + 1]
        doubles.append({"odd": first["odd"] * second["odd"], "hit": first["hit"] and second["hit"]})

    bands = []
    for band in BANDS:
        rows = [row for row in option_rows if band["min"] <= row["odd"] < band["max"]]
        bands.append({"label": band["label"], **summarize(rows)})

    dates = sorted(sample["matchDate"] for sample in usable if sample.get("matchDate"))

    return {
        "window": {"from": dates[0] if dates else None, "to": dates[-1] if dates else None, "matches": len(usable)},
        "singles": summarize(safe_picks),
        "wideSingles": summarize(wide_picks),
        "doubles": summarize(doubles),
        "longshot": summarize(longshot_rows),
        "bands": bands,
        "note": BACKTEST_NOTE,
    }
