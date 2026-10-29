"""串关分析的数据装配（对齐 apps/api/src/ai/parlay-context.mjs）。

一次把串关里所有比赛的数据取齐：3 条 SQL，避免 N 场 × 3 次往返。
"""

from __future__ import annotations

from typing import Any

from .. import db

MATCH_SQL = """
  select sporttery_match_id, match_num_str, league_name, home_name, away_name, kickoff_at
  from match
  where sporttery_match_id = any(%s::bigint[])
"""

ODDS_SQL = """
  select m.sporttery_match_id, s.odds
  from match m
  join lateral (
    select odds from match_odds_snapshot s
    where s.match_id = m.id
    order by s.captured_at desc
    limit 1
  ) s on true
  where m.sporttery_match_id = any(%s::bigint[])
"""

INJURY_SQL = """
  select sporttery_match_id, payload
  from match_feed
  where feed = 'injury' and sporttery_match_id = any(%s::bigint[])
"""


def load_parlay_context(match_ids: list[int]) -> dict[str, dict]:
    ids = [int(match_id) for match_id in match_ids]
    if not ids:
        return {}

    matches = {str(row["sporttery_match_id"]): row for row in db.query(MATCH_SQL, (ids,))}
    odds = {str(row["sporttery_match_id"]): row["odds"] for row in db.query(ODDS_SQL, (ids,))}
    injuries = {str(row["sporttery_match_id"]): row["payload"] for row in db.query(INJURY_SQL, (ids,))}

    return {
        key: {"match": row, "odds": odds.get(key), "injury": injuries.get(key)}
        for key, row in matches.items()
    }


def format_kickoff(iso: Any) -> str:
    from .prompt import beijing_time

    return beijing_time(iso)
