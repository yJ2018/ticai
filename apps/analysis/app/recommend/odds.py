"""赔率解析（纯函数，对齐 apps/api/src/recommend/odds.mjs）。

推荐引擎与回测共用同一套口径，避免「回测一套、线上另一套」。
"""

from __future__ import annotations

import math

from .mathx import devig, parse_goal_line

POOL_ORDER = ("had", "hhad", "ttg")
POOL_LABEL = {"had": "胜平负", "hhad": "让球胜平负", "ttg": "总进球"}


def odds_number(value: object) -> float:
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0
    return parsed if math.isfinite(parsed) and parsed > 1 else 0.0


def read_pools(odds: dict | None) -> dict:
    odds = odds or {}
    hhad = odds.get("hhad") or {}
    # 对齐 JS 的 `goalLine ?? goalLineValue`：空串也算有值（不回落）
    line_raw = hhad.get("goalLine")
    if line_raw is None:
        line_raw = hhad.get("goalLineValue")
    line = parse_goal_line(line_raw)
    if float(line).is_integer():
        line = int(line)  # JSON 里保持 1 / -1，和 Node 版一致
    ttg_raw = odds.get("ttg") or {}
    ttg = {f"s{i}": odds_number(ttg_raw.get(f"s{i}")) for i in range(8)}
    had_raw = odds.get("had") or {}
    return {
        "had": {"h": odds_number(had_raw.get("h")), "d": odds_number(had_raw.get("d")), "a": odds_number(had_raw.get("a"))},
        "hhad": {"h": odds_number(hhad.get("h")), "d": odds_number(hhad.get("d")), "a": odds_number(hhad.get("a"))},
        "hhadLine": line,
        "ttg": ttg,
    }


def market_probabilities(pools: dict) -> dict[str, dict[str, float] | None]:
    """组内去水；某项缺赔率时整组作废（宁可不推，也不要拿半套赔率算概率）。"""
    had = devig([pools["had"]["h"], pools["had"]["d"], pools["had"]["a"]])
    hhad = devig([pools["hhad"]["h"], pools["hhad"]["d"], pools["hhad"]["a"]])
    ttg = devig([pools["ttg"][f"s{i}"] for i in range(8)])
    return {
        "had": {"h": had[0], "d": had[1], "a": had[2]} if had else None,
        "hhad": {"h": hhad[0], "d": hhad[1], "a": hhad[2]} if hhad else None,
        "ttg": {f"s{i}": ttg[i] for i in range(8)} if ttg else None,
    }


def _js_number(value: float | int) -> str:
    """模仿 JS 的 `${number}`：1.0 → "1"，1.5 → "1.5"。"""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def option_label(pool: str, key: str, line: float = 0) -> str:
    if pool == "had":
        return {"h": "胜", "d": "平", "a": "负"}.get(key, key)
    if pool == "hhad":
        tag = f"+{_js_number(line)}" if line > 0 else _js_number(line)
        return f"让球({tag}) {({'h': '胜', 'd': '平', 'a': '负'}).get(key, key)}"
    return "总进球 7+" if key == "s7" else f"总进球 {key[1:]}"
