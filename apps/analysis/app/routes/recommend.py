"""GET /api/recommendations —— 投注推荐（服务端算，前端只展示）。"""

from __future__ import annotations

import time
from datetime import datetime, timezone

from fastapi import APIRouter

from .. import config
from ..recommend.backtest import run_backtest
from ..recommend.data import load_backtest_samples, load_finished_matches, load_injuries, load_slate
from ..recommend.engine import beijing_date, build_recommendation

router = APIRouter()

VALID_POOLS = {"had", "hhad", "ttg", "mixed", "crs", "hafu"}

_cache: dict[str, tuple[float, dict]] = {}
_backtest_cache: dict[str, tuple[float, dict]] = {}


def _cached(store: dict[str, tuple[float, dict]], key: str, ttl: float) -> dict | None:
    hit = store.get(key)
    if not hit:
        return None
    saved_at, value = hit
    if time.time() - saved_at > ttl:
        store.pop(key, None)
        return None
    return value


def _store(store: dict[str, tuple[float, dict]], key: str, value: dict) -> None:
    if len(store) > 32:
        store.clear()
    store[key] = (time.time(), value)


@router.get("/api/recommendations")
def recommendations(pool: str = "mixed", scope: str = "today") -> dict:
    normalized_pool = pool if pool in VALID_POOLS else "mixed"
    normalized_scope = "all" if scope == "all" else "today"
    now = datetime.now(timezone.utc)
    key = f"{normalized_pool}:{normalized_scope}:{beijing_date(now)}"

    cached = _cached(_cache, key, config.cache_ttl_seconds())
    if cached is not None:
        return {"success": True, "data": {**cached, "cache": "hit"}}

    slate = load_slate()
    match_ids = [match["matchId"] for match in slate if match.get("odds")]
    injuries = load_injuries(match_ids)
    finished = load_finished_matches()

    data = build_recommendation(
        slate=slate,
        injuries=injuries,
        finished=finished,
        pool=normalized_pool,
        scope=normalized_scope,
        now=now,
    )

    backtest = _cached(_backtest_cache, "all", 600)
    if backtest is None:
        backtest = run_backtest(load_backtest_samples())
        _store(_backtest_cache, "all", backtest)

    payload = {**data, "backtest": backtest}
    _store(_cache, key, payload)
    return {"success": True, "data": {**payload, "cache": "miss"}}
