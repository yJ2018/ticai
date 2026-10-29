"""AI 分析接口（对齐 apps/api/src/handlers/analysis.mjs 与 parlay.mjs）。

- POST /api/ai-analysis：单场分析，客户端只传 matchId + pool
- POST /api/ai-parlay：串关分析，客户端只传已选场次与选项

流式走 SSE（meta / reasoning / content / done / error），与 Node 版事件协议一致；
非流式返回 {success, data}。
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from .. import config
from ..ai.context import load_match_context, load_weather
from ..ai.parlay_context import format_kickoff, load_parlay_context
from ..ai.parlay_prompt import build_parlay_prompt, describe_leg_odds, format_injury_brief
from ..ai.prompt import POOL_KEYS, build_analysis_prompt, weather_label
from ..errors import AnalysisError
from ..llm import chat_completion, llm_config, open_chat_stream
from ..ratelimit import RateLimiter
from ..venue import get_venue_service

router = APIRouter()

AI_MAX_BODY_BYTES = 256 * 1024
ANALYSIS_MAX_BYTES = 8 * 1024
PARLAY_MAX_BYTES = 64 * 1024
ANALYSIS_MAX_TOKENS = 2_048
PARLAY_MAX_TOKENS = 4_096
PARLAY_MAX_LEGS = 10
PARLAY_MAX_OPTIONS_PER_LEG = 6
PARLAY_MAX_CACHED_CHARS = 900

limiter = RateLimiter(config.ai_rate_per_minute())
_WHITESPACE = re.compile(r"\s+")

SSE_HEADERS = {
    "cache-control": "no-store, no-transform",
    "x-accel-buffering": "no",
}


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    return request.client.host if request.client else ""


def _read_json(raw: bytes) -> Any:
    try:
        return json.loads(raw.decode("utf-8")) if raw else None
    except (UnicodeDecodeError, ValueError) as error:
        raise AnalysisError(400, "请求体必须是合法 JSON") from error


async def _read_body(request: Request, max_bytes: int) -> Any:
    raw = await request.body()
    if len(raw) > max_bytes:
        raise AnalysisError(413, f"请求体过大（上限 {max_bytes // 1024} KB）")
    if not raw:
        raise AnalysisError(400, "请求体不能为空")
    return _read_json(raw)


def _sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _streaming(stream, meta: dict) -> StreamingResponse:
    started_at = time.perf_counter()

    def generate():
        try:
            yield _sse("meta", meta)
            for kind, delta in stream.events():
                yield _sse(kind, {"delta": delta})
            result = stream.result()
            yield _sse("done", {**result, "elapsedMs": int((time.perf_counter() - started_at) * 1000)})
        except AnalysisError as error:
            yield _sse("error", {"status": error.status, "message": error.message})
        except Exception as error:  # noqa: BLE001 - 流已开始，只能发 error 事件
            yield _sse("error", {"status": 502, "message": str(error)})
        finally:
            stream.close()

    return StreamingResponse(generate(), media_type="text/event-stream; charset=utf-8", headers=SSE_HEADERS)


def _text_of(value: Any, limit: int = 40) -> str:
    text = "" if value is None else str(value)
    return _WHITESPACE.sub(" ", text).strip()[:limit]


def _parse_parlay(body: Any) -> dict:
    if not isinstance(body, dict):
        raise AnalysisError(400, "请求体必须是 JSON 对象")

    entries = body.get("entries") if isinstance(body.get("entries"), list) else []
    if not entries:
        raise AnalysisError(400, "entries 不能为空")
    if len(entries) > PARLAY_MAX_LEGS:
        raise AnalysisError(400, f"串关最多 {PARLAY_MAX_LEGS} 场")

    legs = []
    for index, entry in enumerate(entries):
        entry = entry if isinstance(entry, dict) else {}
        match_id = entry.get("matchId")
        try:
            match_id_value = int(match_id)
        except (TypeError, ValueError):
            raise AnalysisError(400, f"entries[{index}].matchId 不合法") from None
        if match_id_value <= 0 or float(match_id) != match_id_value:
            raise AnalysisError(400, f"entries[{index}].matchId 不合法")

        raw_options = entry.get("options") if isinstance(entry.get("options"), list) else []
        if not raw_options:
            raise AnalysisError(400, f"entries[{index}].options 不能为空")
        if len(raw_options) > PARLAY_MAX_OPTIONS_PER_LEG:
            raise AnalysisError(400, f"entries[{index}].options 最多 {PARLAY_MAX_OPTIONS_PER_LEG} 个")

        options = []
        for option in raw_options:
            option = option if isinstance(option, dict) else {}
            options.append({"label": _text_of(option.get("label"), 24), "value": _text_of(option.get("value"), 12)})

        legs.append(
            {
                "order": index + 1,
                "matchId": match_id_value,
                "matchNo": _text_of(entry.get("matchNo"), 16),
                "teams": _text_of(entry.get("teams"), 40),
                "kickoffTime": _text_of(entry.get("kickoffTime"), 24),
                "options": options,
                "cachedAnalysis": _text_of(entry.get("cachedAnalysis"), PARLAY_MAX_CACHED_CHARS),
            }
        )

    def number(value: Any) -> float:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return 0.0
        return parsed if parsed == parsed else 0.0  # NaN → 0

    max_tokens = number(body.get("maxTokens")) or 2400
    return {
        "pool": _text_of(body.get("pool"), 16) or "ttg",
        "passSummaryText": _text_of(body.get("passSummaryText"), 40),
        "betAmount": number(body.get("betAmount")),
        "maxBonus": number(body.get("maxBonus")),
        "legs": legs,
        "stream": body.get("stream") is True,
        "thinking": body.get("thinking") is True,
        "maxTokens": int(min(max(max_tokens, 1), PARLAY_MAX_TOKENS)),
        "temperature": body.get("temperature") if isinstance(body.get("temperature"), (int, float)) else 0.4,
    }


@router.post("/api/ai-analysis")
async def ai_analysis(request: Request):
    body = await _read_body(request, ANALYSIS_MAX_BYTES)
    body = body if isinstance(body, dict) else {}

    try:
        match_id = int(body.get("matchId"))
    except (TypeError, ValueError):
        raise AnalysisError(400, "matchId 必须是正整数") from None
    if match_id <= 0:
        raise AnalysisError(400, "matchId 必须是正整数")

    pool = str(body.get("pool") if body.get("pool") is not None else "ttg")
    if pool not in POOL_KEYS:
        raise AnalysisError(400, f"不支持的玩法：{pool}")

    limiter.hit(_client_ip(request))

    context = load_match_context(match_id)
    if not context:
        raise AnalysisError(404, f"没有这场比赛：{match_id}（可能还没抓取）")

    venue_service = get_venue_service()
    weather = load_weather(venue_service, context["match"])
    prompt = build_analysis_prompt(**context, weather=weather, pool=pool)

    max_tokens = body.get("maxTokens")
    try:
        max_tokens_value = int(float(max_tokens)) if max_tokens is not None and float(max_tokens) else 1500
    except (TypeError, ValueError):
        max_tokens_value = 1500

    options = {
        "thinking": body.get("thinking") is True,
        "maxTokens": min(max(max_tokens_value, 1), ANALYSIS_MAX_TOKENS),
        "temperature": body.get("temperature") if isinstance(body.get("temperature"), (int, float)) else 0.4,
    }

    messages = [
        {"role": "system", "content": prompt["system"]},
        {"role": "user", "content": prompt["user"]},
    ]

    meta = {
        "matchId": match_id,
        "pool": pool,
        "weatherLabel": weather_label(weather),
        "promptChars": prompt["chars"],
        "hasOdds": bool(context["odds"]),
        "feeds": list(context["feeds"].keys()),
    }

    cfg = llm_config()
    if body.get("stream") is True:
        # 先建流：连不上/鉴权失败时仍能用普通 JSON 错误返回
        stream = open_chat_stream(cfg, {"messages": messages, **options})
        return _streaming(stream, meta)

    started_at = time.perf_counter()
    result = chat_completion(cfg, {"messages": messages, **options})
    return {
        "success": True,
        "data": {**result, "meta": meta, "elapsedMs": int((time.perf_counter() - started_at) * 1000)},
    }


@router.post("/api/ai-parlay")
async def ai_parlay(request: Request):
    body = await _read_body(request, PARLAY_MAX_BYTES)
    input_data = _parse_parlay(body)

    limiter.hit(_client_ip(request))

    context = load_parlay_context([leg["matchId"] for leg in input_data["legs"]])

    matched = 0
    legs = []
    for leg in input_data["legs"]:
        found = context.get(str(leg["matchId"]))
        if found:
            matched += 1
        selected = "、".join(
            f"{option['label']}{'（' + option['value'] + '）' if option['value'] else ''}"
            for option in leg["options"]
        )
        match_row = found["match"] if found else {}
        legs.append(
            {
                "order": leg["order"],
                "matchNo": leg["matchNo"] or match_row.get("match_num_str") or "",
                "teams": leg["teams"]
                or (f"{match_row.get('home_name')} vs {match_row.get('away_name')}" if found else ""),
                "league": (match_row.get("league_name") if found else None) or "未知赛事",
                "kickoff": leg["kickoffTime"] or format_kickoff(match_row.get("kickoff_at")) or "未知时间",
                "selected": selected,
                "odds": describe_leg_odds(found["odds"], input_data["pool"]) if found else "",
                "injuries": format_injury_brief(
                    {"injury": found.get("injury") or {}},
                    match_row.get("home_name") or "",
                    match_row.get("away_name") or "",
                )
                if found
                else "",
                "cachedAnalysis": leg["cachedAnalysis"],
            }
        )

    prompt = build_parlay_prompt(
        pool=input_data["pool"],
        pass_summary_text=input_data["passSummaryText"],
        bet_amount=input_data["betAmount"],
        max_bonus=input_data["maxBonus"],
        legs=legs,
    )

    messages = [
        {"role": "system", "content": prompt["system"]},
        {"role": "user", "content": prompt["user"]},
    ]
    options = {
        "thinking": input_data["thinking"],
        "maxTokens": input_data["maxTokens"],
        "temperature": input_data["temperature"],
    }
    meta = {
        "legs": len(legs),
        "matched": matched,
        "promptChars": prompt["chars"],
        "pool": input_data["pool"],
    }

    cfg = llm_config()
    if input_data["stream"]:
        stream = open_chat_stream(cfg, {"messages": messages, **options})
        return _streaming(stream, meta)

    started_at = time.perf_counter()
    result = chat_completion(cfg, {"messages": messages, **options})
    return {
        "success": True,
        "data": {**result, "meta": meta, "elapsedMs": int((time.perf_counter() - started_at) * 1000)},
    }
