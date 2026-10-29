"""开奖分析编排：读开奖 → 算 → 快照读写（对齐 apps/api/src/analysis/compute.mjs）。"""

from __future__ import annotations

import json
import platform
import time
from datetime import datetime, timezone
from typing import Any

from .. import db
from ..errors import AnalysisError
from .configs import (
    DLT_WINDOW,
    ENGINE_VERSION,
    analysis_options,
    dlt_config_key,
    math_trend_config_key,
    prediction_config_key,
)
from .dlt import analyze_dlt_recommendation
from .prediction import analyze_history_prediction, analyze_math_trend_prediction

# 算法版本写进快照 meta：事后能判断某条快照是哪一版代码算的
ENGINE_DIGEST = "python-port-1"
ANALYSIS_ENGINE = {
    "version": ENGINE_VERSION,
    "digest": ENGINE_DIGEST,
    "runtime": f"python {platform.python_version()}",
}

GAME_SQL = """
  select game_no, game_key, name, is_positional, digit_count, main_count, extra_count
  from lottery_game
  where game_no = %s or game_key = %s
  limit 1
"""

DRAWS_SQL = """
  select
    issue,
    issue_seq,
    to_char(draw_date, 'YYYY-MM-DD') as draw_date,
    main_numbers,
    extra_numbers
  from lottery_draw
  where game_no = %s
  order by issue_seq desc
"""

UPSERT_SQL = """
  insert into lottery_analysis_snapshot (
    game_no, kind, config_key,
    through_issue, through_issue_seq, through_draw_date,
    from_issue, from_issue_seq, from_draw_date,
    draw_count, payload, meta, source, crawl_run_id, duration_ms
  ) values (
    %s, %s, %s,
    %s, %s, %s,
    %s, %s, %s,
    %s, %s::jsonb, %s::jsonb, %s, %s, %s
  )
  on conflict (game_no, kind, config_key, through_issue) do update set
    through_issue_seq = excluded.through_issue_seq,
    through_draw_date  = excluded.through_draw_date,
    from_issue         = excluded.from_issue,
    from_issue_seq     = excluded.from_issue_seq,
    from_draw_date     = excluded.from_draw_date,
    draw_count         = excluded.draw_count,
    payload            = excluded.payload,
    meta               = excluded.meta,
    source             = excluded.source,
    crawl_run_id       = coalesce(excluded.crawl_run_id, lottery_analysis_snapshot.crawl_run_id),
    duration_ms        = excluded.duration_ms,
    computed_at        = now()
  returning id, computed_at
"""

LATEST_SNAPSHOT_SQL = """
  select
    s.id,
    s.game_no,
    s.kind,
    s.config_key,
    s.through_issue,
    s.through_issue_seq,
    to_char(s.through_draw_date, 'YYYY-MM-DD') as through_draw_date,
    s.from_issue,
    s.from_issue_seq,
    to_char(s.from_draw_date, 'YYYY-MM-DD') as from_draw_date,
    s.draw_count,
    s.payload,
    s.meta,
    s.source,
    s.duration_ms,
    s.computed_at,
    d.issue      as latest_issue,
    d.issue_seq  as latest_issue_seq,
    to_char(d.draw_date, 'YYYY-MM-DD') as latest_draw_date
  from lottery_analysis_snapshot s
  left join lateral (
    select dd.issue, dd.issue_seq, dd.draw_date
    from lottery_draw dd
    where dd.game_no = s.game_no
    order by dd.issue_seq desc
    limit 1
  ) d on true
  where s.game_no = %s and s.kind = %s and s.config_key = %s
  order by s.through_issue_seq desc
  limit 1
"""

LATEST_VERSIONS_SQL = """
  select v.game_no, v.game_key, v.game_name, v.kind, v.config_key, v.through_issue, v.through_issue_seq,
         to_char(v.through_draw_date, 'YYYY-MM-DD') as through_draw_date,
         v.draw_count, v.source, v.duration_ms, v.computed_at,
         v.latest_issue, v.latest_issue_seq, to_char(v.latest_draw_date, 'YYYY-MM-DD') as latest_draw_date
  from lottery_analysis_latest v
  where (%s::text is null or v.game_no = %s or v.game_key = %s)
  order by v.game_key, v.kind, v.config_key
"""


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return _iso(parsed)


def load_game_row(game_key_or_no: str) -> dict | None:
    rows = db.query(GAME_SQL, (str(game_key_or_no), str(game_key_or_no)))
    return rows[0] if rows else None


def load_draws(game_no: str) -> list[dict]:
    rows = db.query(DRAWS_SQL, (game_no,))
    draws = []
    for row in rows:
        numbers = [str(value) for value in (row["main_numbers"] or [])] + [
            str(value) for value in (row["extra_numbers"] or [])
        ]
        draws.append(
            {
                "issue": row["issue"],
                "issueSeq": int(row["issue_seq"]),
                "drawDate": row["draw_date"],
                "numbers": numbers,
            }
        )
    return draws


def _to_snapshot(row: dict) -> dict:
    return {
        "id": int(row["id"]),
        "gameNo": row["game_no"],
        "kind": row["kind"],
        "configKey": row["config_key"],
        "sample": {
            "throughIssue": row["through_issue"],
            "throughIssueSeq": int(row["through_issue_seq"]),
            "throughDrawDate": row["through_draw_date"],
            "fromIssue": row["from_issue"],
            "fromIssueSeq": None if row["from_issue_seq"] is None else int(row["from_issue_seq"]),
            "fromDrawDate": row["from_draw_date"],
            "drawCount": row["draw_count"],
        },
        "latestDraw": None
        if row["latest_issue"] is None
        else {
            "issue": row["latest_issue"],
            "issueSeq": int(row["latest_issue_seq"]),
            "drawDate": row["latest_draw_date"],
        },
        "payload": row["payload"],
        "meta": row["meta"] or {},
        "source": row["source"],
        "durationMs": row["duration_ms"],
        "computedAt": _iso(row["computed_at"]),
    }


def read_latest_snapshot(game_no: str, kind: str, config_key: str) -> dict | None:
    rows = db.query(LATEST_SNAPSHOT_SQL, (game_no, kind, config_key))
    return _to_snapshot(rows[0]) if rows else None


def list_latest_versions(game_key: str | None = None) -> list[dict]:
    rows = db.query(LATEST_VERSIONS_SQL, (game_key, game_key, game_key))
    versions = []
    for row in rows:
        versions.append(
            {
                "gameNo": row["game_no"],
                "gameKey": row["game_key"],
                "gameName": row["game_name"],
                "kind": row["kind"],
                "configKey": row["config_key"],
                "throughIssue": row["through_issue"],
                "throughIssueSeq": int(row["through_issue_seq"]),
                "throughDrawDate": row["through_draw_date"],
                "drawCount": row["draw_count"],
                "source": row["source"],
                "durationMs": row["duration_ms"],
                "computedAt": _iso(row["computed_at"]),
                "latestIssue": row["latest_issue"],
                "latestIssueSeq": None if row["latest_issue_seq"] is None else int(row["latest_issue_seq"]),
                "latestDrawDate": row["latest_draw_date"],
                "stale": False
                if row["latest_issue_seq"] is None
                else int(row["latest_issue_seq"]) > int(row["through_issue_seq"]),
            }
        )
    return versions


def _used_draw_count(kind: str, draws: list[dict], options: dict) -> int:
    if kind == "math_trend":
        return min(options.get("sampleWindow", 0), len(draws))
    if kind == "dlt":
        return min(DLT_WINDOW, len(draws))
    return len(draws)


def compute_analysis(kind: str, game: dict, draws: list[dict], config_key: str) -> dict:
    if not draws:
        return {"payload": None, "sample": None}

    options = analysis_options(kind, game, config_key)
    entries = [{"issue": draw["issue"], "numbers": draw["numbers"]} for draw in draws]

    if kind == "prediction":
        payload = analyze_history_prediction(entries, options)
    elif kind == "math_trend":
        payload = analyze_math_trend_prediction(entries, options)
    elif kind == "dlt":
        # 大乐透推演只认「最近 300 期、最新在前」，函数内部按窗口截断
        payload = analyze_dlt_recommendation([{"numbers": draw["numbers"]} for draw in draws])
    else:
        raise AnalysisError(400, f"未知分析种类：{kind}")

    if not payload:
        return {"payload": None, "sample": None}

    used = max(1, _used_draw_count(kind, draws, options))
    latest = draws[0]
    oldest = draws[min(used, len(draws)) - 1]
    return {
        "payload": payload,
        "sample": {
            "throughIssue": latest["issue"],
            "throughIssueSeq": latest["issueSeq"],
            "throughDrawDate": latest["drawDate"],
            "fromIssue": oldest["issue"],
            "fromIssueSeq": oldest["issueSeq"],
            "fromDrawDate": oldest["drawDate"],
            "drawCount": min(used, len(draws)),
        },
    }


def _build_meta(*, kind: str, game: dict, config_key: str, options: dict, draw_count: int) -> dict:
    return {
        "engine": "python",
        "engineVersion": ENGINE_VERSION,
        "engineDigest": ENGINE_DIGEST,
        "kind": kind,
        "gameKey": game["game_key"],
        "configKey": config_key,
        "options": options,
        "loadedDrawCount": draw_count,
    }


def save_snapshot(snapshot: dict) -> dict:
    sample = snapshot["sample"]
    rows = db.query(
        UPSERT_SQL,
        (
            snapshot["gameNo"],
            snapshot["kind"],
            snapshot["configKey"],
            sample["throughIssue"],
            sample["throughIssueSeq"],
            sample["throughDrawDate"],
            sample["fromIssue"],
            sample["fromIssueSeq"],
            sample["fromDrawDate"],
            sample["drawCount"],
            json.dumps(snapshot["payload"], ensure_ascii=False),
            json.dumps(snapshot.get("meta") or {}, ensure_ascii=False),
            snapshot["source"],
            snapshot.get("crawlRunId"),
            snapshot.get("durationMs"),
        ),
    )
    return rows[0] if rows else {}


def ensure_snapshot(*, game: dict, kind: str, config_key: str, source: str = "api") -> dict | None:
    draws = load_draws(game["game_no"])
    if not draws:
        return None

    started = time.perf_counter()
    result = compute_analysis(kind, game, draws, config_key)
    duration_ms = int((time.perf_counter() - started) * 1000)
    if not result["payload"] or not result["sample"]:
        return None

    save_snapshot(
        {
            "gameNo": game["game_no"],
            "kind": kind,
            "configKey": config_key,
            "sample": result["sample"],
            "payload": result["payload"],
            "meta": _build_meta(
                kind=kind,
                game=game,
                config_key=config_key,
                options=analysis_options(kind, game, config_key),
                draw_count=len(draws),
            ),
            "source": source,
            "durationMs": duration_ms,
        }
    )
    print(f"[analysis] {game['game_key']} {kind}/{config_key} 快照缺失，已现算并落库（{duration_ms}ms）", flush=True)
    return read_latest_snapshot(game["game_no"], kind, config_key)


def default_config_key(kind: str) -> str:
    if kind == "prediction":
        return prediction_config_key()
    if kind == "math_trend":
        return math_trend_config_key()
    return dlt_config_key()
