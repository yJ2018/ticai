"""推荐引擎的数据层（对齐 apps/api/src/recommend/data.mjs）。

数据口径（2026-10 实测）：
  - 在售赛事：19 场左右，全部有最新赔率（5 个玩法）；
  - 伤停 feed：`match_feed.injury`，覆盖部分场次（爬虫默认只抓这一路）；
  - 历史战绩：`match` 里 status='finished' 且有比分（近两周约 111 场，样本很薄）；
  - 回测样本：`match_result` × 赛前赔率快照（111 场），这是目前唯一能自证的数据。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .. import db
from .engine import iso_js

SLATE_SQL = """
  select
    m.sporttery_match_id,
    m.match_num_str,
    m.league_name,
    m.home_name,
    m.away_name,
    m.kickoff_at,
    to_char(
      coalesce(m.business_date, (m.kickoff_at at time zone 'Asia/Shanghai')::date),
      'YYYY-MM-DD'
    ) as business_date,
    m.home_team_id,
    m.away_team_id,
    s.odds,
    s.captured_at as odds_captured_at
  from match m
  left join lateral (
    select s2.odds, s2.captured_at
    from match_odds_snapshot s2
    where s2.match_id = m.id
    order by s2.captured_at desc
    limit 1
  ) s on true
  where m.sell_status = 'on_sale'
  order by m.kickoff_at
  limit 500
"""

FINISHED_SQL = """
  select id, sporttery_match_id, kickoff_at, home_team_id, away_team_id, home_score, away_score, league_name
  from match
  where status = 'finished' and home_score is not null and away_score is not null
  order by kickoff_at desc
  limit 2000
"""

INJURY_SQL = """
  select distinct on (sporttery_match_id) sporttery_match_id, payload, fetched_at
  from match_feed
  where feed = 'injury' and sporttery_match_id = any(%s::bigint[])
  order by sporttery_match_id, fetched_at desc
"""

BACKTEST_SQL = """
  select
    r.sporttery_match_id,
    r.match_date,
    r.goal_line,
    r.had_result,
    r.hhad_result,
    r.ttg_result,
    r.full_home,
    r.full_away,
    m.kickoff_at,
    m.league_name,
    m.home_name,
    m.away_name,
    (
      select s.odds
      from match_odds_snapshot s
      where s.match_id = m.id
        and s.captured_at <= coalesce(m.kickoff_at, now())
      order by s.captured_at desc
      limit 1
    ) as odds
  from match_result r
  join match m on m.sporttery_match_id = r.sporttery_match_id
  where r.had_result is not null
  order by m.kickoff_at
"""


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return iso_js(value)


def _int(value: Any) -> int | None:
    return None if value is None else int(value)


def load_slate() -> list[dict]:
    rows = db.query(SLATE_SQL)
    return [
        {
            "matchId": int(row["sporttery_match_id"]),
            "matchNo": row["match_num_str"] or "",
            "league": row["league_name"] or "",
            "homeName": row["home_name"] or "",
            "awayName": row["away_name"] or "",
            "kickoffAt": _iso(row["kickoff_at"]),
            "businessDate": row["business_date"] or "",
            "homeTeamId": _int(row["home_team_id"]),
            "awayTeamId": _int(row["away_team_id"]),
            "odds": row["odds"] if isinstance(row["odds"], dict) else None,
            "oddsCapturedAt": _iso(row["odds_captured_at"]),
        }
        for row in rows
    ]


def load_injuries(match_ids: list[int]) -> dict[int, dict]:
    if not match_ids:
        return {}
    rows = db.query(INJURY_SQL, (match_ids,))

    def side(value: Any) -> dict:
        payload = value or {}
        raw = payload.get("injuriesAndSuspensionsList")
        if not isinstance(raw, list):
            return {"count": 0, "names": []}
        names = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            name = item.get("playerName") or item.get("personName") or item.get("name") or ""
            if name:
                names.append(str(name))
        return {"count": len(raw), "names": names[:4]}

    injuries: dict[int, dict] = {}
    for row in rows:
        payload = row["payload"] or {}
        injuries[int(row["sporttery_match_id"])] = {
            "home": side(payload.get("home")),
            "away": side(payload.get("away")),
            "fetchedAt": _iso(row["fetched_at"]),
        }
    return injuries


def load_finished_matches() -> list[dict]:
    rows = db.query(FINISHED_SQL)
    return [
        {
            "id": int(row["id"]),
            "matchId": int(row["sporttery_match_id"]),
            "kickoffAt": _iso(row["kickoff_at"]),
            "homeTeamId": _int(row["home_team_id"]),
            "awayTeamId": _int(row["away_team_id"]),
            "homeScore": int(row["home_score"]),
            "awayScore": int(row["away_score"]),
            "league": row["league_name"] or "",
        }
        for row in rows
    ]


def load_backtest_samples() -> list[dict]:
    """回测样本：已开奖 + 开赛前就有赔率快照（赛后赔率会收敛到结果，用它等于作弊）。"""
    rows = db.query(BACKTEST_SQL)
    samples = []
    for row in rows:
        odds = row["odds"]
        if not isinstance(odds, dict):
            continue
        samples.append(
            {
                "matchId": int(row["sporttery_match_id"]),
                "matchDate": row["match_date"].isoformat()[:10] if row["match_date"] else "",
                "kickoffAt": _iso(row["kickoff_at"]),
                "league": row["league_name"] or "",
                "homeName": row["home_name"] or "",
                "awayName": row["away_name"] or "",
                "goalLine": int(row["goal_line"] or 0),
                "hadResult": row["had_result"],
                "hhadResult": row["hhad_result"],
                "ttgResult": None if row["ttg_result"] is None else int(row["ttg_result"]),
                "fullHome": int(row["full_home"] or 0),
                "fullAway": int(row["full_away"] or 0),
                "odds": odds,
            }
        )
    return samples
