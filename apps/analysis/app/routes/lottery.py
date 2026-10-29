"""开奖分析接口（对齐 apps/api/src/handlers/lottery-analysis.mjs）。

- GET /api/analysis/lottery?game=&kind=&order=   最新快照（缺失时现算并落库）
- GET /api/analysis/lottery/snapshots?game=      各彩种各分析的最新版本
"""

from __future__ import annotations

import math
import re
import time

from fastapi import APIRouter, Response

from ..analysis.compute import (
    ANALYSIS_ENGINE,
    default_config_key,
    ensure_snapshot,
    list_latest_versions,
    load_game_row,
    read_latest_snapshot,
)
from ..analysis.configs import KINDS, default_kind_for_game, prediction_config_key
from ..errors import AnalysisError

router = APIRouter()

GAME_PATTERN = re.compile(r"^[0-9a-z]{2,8}$", re.I)


@router.get("/api/analysis/lottery")
def latest(
    response: Response,
    game: str = "pl5",
    kind: str | None = None,
    order: int = 0,
    w: str | None = None,
) -> dict:
    handler_started = time.perf_counter()

    if not GAME_PATTERN.match(game):
        raise AnalysisError(400, "game 参数不合法（用 pl5 / qxc / dlt 或体彩 gameNo）")
    game_row = load_game_row(game)
    if not game_row:
        raise AnalysisError(404, f"未知彩种：{game}（请先执行 npm run db:seed）")

    resolved_kind = kind or default_kind_for_game(game_row)
    if resolved_kind not in KINDS:
        raise AnalysisError(400, f"不支持的 kind：{resolved_kind}（可用 {' / '.join(KINDS)}）")

    order_value = 0
    if order:
        order_value = min(max(int(order), 1), 5)

    # 自定义权重（滑块）：`w=34-20-22-14-10`，五项百分比；只在 prediction 生效。
    # 参数化后 config_key 会带上 `;w=...`，快照按参数各存一条，天然幂等。
    score_weights = None
    if resolved_kind == "prediction" and w:
        parts = w.split("-")
        try:
            values = [float(part) for part in parts]
        except ValueError:
            values = []
        if len(values) == 5 and all(math.isfinite(value) for value in values):
            score_weights = {
                key: values[index] / 100
                for index, key in enumerate(("recent", "long", "omission", "transition", "pairTransition"))
            }

    config_key = (
        prediction_config_key({"markovOrder": order_value or None, "scoreWeights": score_weights})
        if resolved_kind == "prediction"
        else default_config_key(resolved_kind)
    )

    read_started = time.perf_counter()
    snapshot = read_latest_snapshot(game_row["game_no"], resolved_kind, config_key)
    read_ms = (time.perf_counter() - read_started) * 1000
    triggered = False

    if snapshot is None:
        triggered = True
        snapshot = ensure_snapshot(game=game_row, kind=resolved_kind, config_key=config_key, source="api")

    if snapshot is None:
        raise AnalysisError(
            404,
            f"还没有 {game_row['name']} {resolved_kind} 的分析结果：样本不足或开奖还没抓取。"
            "可执行 npm run analyze:snapshot 手动生成。",
        )

    latest_draw = snapshot["latestDraw"]
    stale = bool(latest_draw and latest_draw["issueSeq"] > snapshot["sample"]["throughIssueSeq"])

    response.headers["cache-control"] = (
        "public, max-age=30, s-maxage=60"
        if stale
        else "public, max-age=300, s-maxage=900, stale-while-revalidate=120"
    )
    response.headers["x-analysis-game"] = game_row["game_key"]
    response.headers["x-analysis-kind"] = resolved_kind
    response.headers["x-analysis-config"] = config_key
    response.headers["x-analysis-through-issue"] = str(snapshot["sample"]["throughIssue"])
    response.headers["x-analysis-through-date"] = str(snapshot["sample"]["throughDrawDate"] or "")
    response.headers["x-analysis-draw-count"] = str(snapshot["sample"]["drawCount"])
    response.headers["x-analysis-computed-at"] = snapshot["computedAt"] or ""
    response.headers["x-analysis-stale"] = "1" if stale else "0"
    response.headers["x-analysis-source"] = "computed-on-read" if triggered else str(snapshot["source"])
    response.headers["server-timing"] = (
        f"snapshot;dur={read_ms:.1f},app;dur={(time.perf_counter() - handler_started) * 1000:.1f}"
    )

    return {
        "success": True,
        "data": {
            "game": {
                "gameKey": game_row["game_key"],
                "gameNo": game_row["game_no"],
                "name": game_row["name"],
                "positional": bool(game_row["is_positional"]),
                "mainCount": game_row["main_count"],
            },
            "kind": resolved_kind,
            "configKey": config_key,
            "sample": snapshot["sample"],
            "engine": ANALYSIS_ENGINE,
            "analysis": snapshot["payload"],
            "computedAt": snapshot["computedAt"],
            "source": snapshot["source"],
            "durationMs": snapshot["durationMs"],
            "triggered": triggered,
            "stale": stale,
            "latestDraw": latest_draw,
        },
    }


@router.get("/api/analysis/lottery/snapshots")
def snapshots(game: str = "") -> dict:
    game_row = load_game_row(game) if game else None
    if game and not game_row:
        raise AnalysisError(404, f"未知彩种：{game}")

    versions = list_latest_versions(game_row["game_no"] if game_row else None)

    by_game: dict[str, dict] = {}
    for item in versions:
        current = by_game.get(item["gameNo"])
        if current:
            current["items"].append(item)
        else:
            by_game[item["gameNo"]] = {
                "gameNo": item["gameNo"],
                "gameKey": item["gameKey"],
                "gameName": item["gameName"],
                "latestIssue": item["latestIssue"],
                "latestDrawDate": item["latestDrawDate"],
                "items": [item],
            }

    return {"success": True, "data": {"games": list(by_game.values())}}
