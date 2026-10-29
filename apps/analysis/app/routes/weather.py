"""比赛地天气接口（对齐 apps/api/src/handlers/upstream.mjs 的 venueWeather）。"""

from __future__ import annotations

import re

from fastapi import APIRouter, Request

from .. import config
from ..errors import AnalysisError
from ..ratelimit import RateLimiter
from ..venue import get_venue_service

router = APIRouter()

limiter = RateLimiter(config.venue_rate_per_minute())
_CONTROL_CHARS = re.compile(r"[\u0000-\u001f\u007f]")


def _text_param(value: str | None, fallback: str = "") -> str:
    raw = fallback if value is None else value
    return _CONTROL_CHARS.sub("", raw).strip()[:64]


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    return request.client.host if request.client else ""


@router.get("/api/venue-weather")
def venue_weather(
    request: Request,
    homeTeam: str | None = None,
    league: str | None = None,
    kickoff: str | None = None,
    teamId: int = 0,
) -> dict:
    home_team = _text_param(homeTeam)
    if not home_team:
        raise AnalysisError(400, "缺少 homeTeam 参数")

    limiter.hit(_client_ip(request))

    data = get_venue_service().get(
        team_id=teamId or None,
        home_team=home_team,
        league=_text_param(league),
        kickoff=_text_param(kickoff),
    )
    return {"success": True, "data": data}
