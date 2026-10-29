"""单场分析的数据装配（对齐 apps/api/src/ai/context.mjs）。

客户端只给 matchId，比赛 + 最新赔率 + 对战数据快照 + 阵容 + 天气全部由这里补齐。
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from typing import Any

from .. import db

MATCH_SQL = """
  select sporttery_match_id, match_num_str, league_name, home_name, away_name,
         kickoff_at, status, home_team_id, away_team_id
  from match
  where sporttery_match_id = %s
"""

ODDS_SQL = """
  select s.odds
  from match_odds_snapshot s
  join match m on m.id = s.match_id
  where m.sporttery_match_id = %s
  order by s.captured_at desc
  limit 1
"""

FEED_SQL = "select feed, payload from match_feed where sporttery_match_id = %s"

LINEUP_SQL = """
  select ml.team_id, ml.formation, ml.confirmed, p.name, mlp.is_starter
  from match_lineup ml
  join match m on m.id = ml.match_id
  join match_lineup_player mlp
    on mlp.match_id = ml.match_id and mlp.team_id = ml.team_id
  join player p on p.id = mlp.player_id
  where m.sporttery_match_id = %s
  order by ml.team_id, mlp.is_starter desc, p.name
"""


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        from datetime import timezone

        if getattr(value, "tzinfo", None) is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return str(value)


def shape_lineup(rows: list[dict], match: dict) -> dict | None:
    """阵容只取首发与阵型，够提示词用即可。"""
    if not rows:
        return None

    def build(team_id: Any) -> dict | None:
        team_rows = [row for row in rows if str(row.get("team_id")) == str(team_id)]
        if not team_rows:
            return None
        return {
            "formation": team_rows[0].get("formation"),
            "confirmed": team_rows[0].get("confirmed") is True,
            "starters": [row["name"] for row in team_rows if row.get("is_starter") is True and row.get("name")],
        }

    home = build(match.get("homeTeamId"))
    away = build(match.get("awayTeamId"))
    return {"home": home, "away": away} if (home or away) else None


def load_match_context(match_id: int) -> dict | None:
    matches = db.query(MATCH_SQL, (match_id,))
    if not matches:
        return None

    row = matches[0]
    odds_rows = db.query(ODDS_SQL, (match_id,))
    feed_rows = db.query(FEED_SQL, (match_id,))
    lineup_rows = db.query(LINEUP_SQL, (match_id,))

    feeds = {feed["feed"]: feed["payload"] for feed in feed_rows}

    match = {
        "matchNo": row.get("match_num_str"),
        "league": row.get("league_name"),
        "homeName": row.get("home_name"),
        "awayName": row.get("away_name"),
        "kickoffAt": _iso(row.get("kickoff_at")),
        "status": row.get("status"),
        "homeTeamId": row.get("home_team_id"),
        "awayTeamId": row.get("away_team_id"),
    }

    return {
        "match": match,
        "odds": odds_rows[0]["odds"] if odds_rows else None,
        "feeds": feeds,
        "lineup": shape_lineup(lineup_rows, match),
    }


def load_weather(venue_service: Any, match: dict, timeout_ms: int = 5_000) -> dict | None:
    """天气是增强信息：最多等 timeoutMs，失败一律当「没有」，绝不拖慢分析主链路。"""
    if venue_service is None:
        return None

    def call() -> dict | None:
        try:
            return venue_service.get(
                team_id=None,
                home_team=match.get("homeName") or "",
                league=match.get("league") or "",
                kickoff=match.get("kickoffAt") or "",
            )
        except Exception:  # noqa: BLE001 - 天气失败不影响分析
            return None

    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(call)
    try:
        return future.result(timeout=timeout_ms / 1000)
    except FutureTimeout:
        return None
    finally:
        # 不能用 wait=True：那会把「最多等 5 秒」变成「等模型超时」
        executor.shutdown(wait=False)
