"""比赛地天气（对齐 apps/api/src/venue.mjs）。

体彩接口没有场地/城市字段，所以分两步：
1. 让 DeepSeek 根据「主队中文名 + 联赛」给出主队所在城市的拉丁名（JSON，低温度）；
2. 用 Open-Meteo 的免费 Geocoding + Forecast API 取该城市当前天气和开赛时段预报。

城市解析结果按球队缓存 7 天，天气按坐标 + 开赛小时缓存 20 分钟；
解析失败会短暂缓存，避免反复消耗模型额度。
"""

from __future__ import annotations

import json
import math
import re
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

from . import config
from .errors import AnalysisError
from .llm import chat_completion, llm_config

WEATHER_TEXT = {
    0: "晴",
    1: "大部晴朗",
    2: "多云",
    3: "阴",
    45: "雾",
    48: "雾凇",
    51: "小毛毛雨",
    53: "毛毛雨",
    55: "大毛毛雨",
    56: "冻毛毛雨",
    57: "强冻毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    66: "冻雨",
    67: "强冻雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    77: "雪粒",
    80: "小阵雨",
    81: "阵雨",
    82: "强阵雨",
    85: "小阵雪",
    86: "强阵雪",
    95: "雷暴",
    96: "雷暴伴小冰雹",
    99: "雷暴伴大冰雹",
}

COUNTRY_ALIASES = {
    "uk": "united kingdom",
    "great britain": "united kingdom",
    "usa": "united states",
    "us": "united states",
    "uae": "united arab emirates",
    "south korea": "korea",
    "north korea": "korea",
    "czech republic": "czechia",
    "turkey": "turkiye",
}

SYSTEM_PROMPT = """你是足球地理信息助手。根据中国竞彩的主队中文名和联赛名，判断该队主场所在城市。
只输出 json，不要输出解释或 Markdown：
{"city":"城市拉丁名","country":"国家英文名","stadium":"球场名或空字符串","confidence":"high|medium|low"}
要求：
- city 必须是当地语言的拉丁化名称，用于地理编码，例如 帕尔马→Parma、代格福什→Degerfors、热刺→London；
- country 使用常见英文名，例如 Italy、Sweden、England；
- 不确定时 confidence 填 low，不要编造；
- 球场名不确定时填空字符串。"""

_CITY_PATTERN = re.compile(r"^[A-Za-z\u00C0-\u024F\u0300-\u036f\s.'()\-]{2,80}$")
_KICKOFF_PATTERN = re.compile(r"^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})")


class TtlCache:
    """TTL + LRU（容量到顶先淘汰最久未用的），对齐 Node 的 createTtlCache。"""

    def __init__(self, ttl_ms: float, max_entries: int = 500) -> None:
        self.ttl_ms = ttl_ms
        self.max_entries = max_entries
        self._store: dict[str, tuple[float, Any]] = {}

    def get(self, key: str) -> Any:
        hit = self._store.get(key)
        if hit is None:
            return None, False
        saved_at, value = hit
        if (now_ms() - saved_at) > self.ttl_ms:
            self._store.pop(key, None)
            return None, False
        self._store.pop(key, None)
        self._store[key] = (saved_at, value)
        return value, True

    def set(self, key: str, value: Any) -> None:
        if len(self._store) >= self.max_entries and key not in self._store:
            oldest = next(iter(self._store), None)
            if oldest is not None:
                self._store.pop(oldest, None)
        self._store.pop(key, None)
        self._store[key] = (now_ms(), value)


def now_ms() -> float:
    import time

    return time.time() * 1000


def weather_text(code: Any) -> str:
    try:
        return WEATHER_TEXT.get(int(code), "未知天气")
    except (TypeError, ValueError):
        return "未知天气"


def js_round(value: Any, digits: int = 1) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    factor = 10**digits
    return math.floor(number * factor + 0.5) / factor


def normalize(value: Any) -> str:
    text = unicodedata.normalize("NFD", str(value if value is not None else "").lower())
    text = "".join(char for char in text if unicodedata.category(char) != "Mn")
    text = re.sub(r"[^a-z0-9 ]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def country_matches(result: dict, wanted: str) -> bool:
    if not wanted:
        return True
    target = COUNTRY_ALIASES.get(wanted, wanted)
    country = normalize(result.get("country"))
    code = normalize(result.get("country_code"))
    admin = normalize(result.get("admin1"))
    return (
        country == target
        or code == target
        or admin == target
        or target in country
        or country in target
    )


def parse_beijing_kickoff(value: Any) -> float | None:
    """北京时间字符串 → epoch 秒；对齐 JS `Date.UTC(y, m-1, d, h-8, min)`。"""
    match = _KICKOFF_PATTERN.match(str(value if value is not None else "").strip())
    if not match:
        return None
    year, month, day, hour, minute = (int(part) for part in match.groups())
    try:
        base = datetime(year, month, day, tzinfo=timezone.utc)
    except ValueError:
        return None
    moment = base + timedelta(hours=hour - 8, minutes=minute)
    return moment.timestamp()


def _fetch_json(url: str, timeout_ms: int) -> dict:
    request = urllib.request.Request(
        url,
        headers={"accept": "application/json", "user-agent": "ticai-bff/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=max(timeout_ms / 1000, 1)) as response:
            text = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        raise AnalysisError(502, f"HTTP {error.code}") from error
    except Exception as error:  # noqa: BLE001 - 网络异常统一转 502
        raise AnalysisError(502, f"上游请求失败：{error}") from error
    try:
        return json.loads(text)
    except ValueError as error:
        raise AnalysisError(502, "上游返回了非 JSON 内容") from error


def pick_geocode_result(results: Any, wanted_country: str) -> dict | None:
    if not isinstance(results, list) or not results:
        return None
    candidates = [item for item in results if country_matches(item, wanted_country)]
    if not candidates:
        return None
    candidates.sort(key=lambda item: -(float(item.get("population") or 0)))
    return candidates[0]


def build_kickoff_forecast(payload: dict, kickoff: Any) -> dict | None:
    epoch = parse_beijing_kickoff(kickoff)
    hourly = (payload or {}).get("hourly") or {}
    times = hourly.get("time")
    if epoch is None or not isinstance(times, list):
        return None

    try:
        offset = float((payload or {}).get("utc_offset_seconds"))
    except (TypeError, ValueError):
        return None
    if not math.isfinite(offset):
        return None

    # 把北京时间换算成场地当地的开赛时间，再和 hourly.time（当地 ISO 字符串）对齐
    local = datetime.fromtimestamp(epoch + offset, tz=timezone.utc)
    local_kickoff = local.strftime("%Y-%m-%dT%H:%M")
    hour_key = local_kickoff[:13]
    index = next(
        (
            position
            for position, time in enumerate(times)
            if isinstance(time, str) and time[:13] == hour_key
        ),
        -1,
    )
    if index < 0:
        return None

    def at(series: Any) -> Any:
        return series[index] if isinstance(series, list) and index < len(series) else None

    return {
        # 实际开赛的当地时间（分钟精度）；天气取同一小时的预报
        "time": local_kickoff,
        "forecastTime": times[index],
        "temperature": js_round(at(hourly.get("temperature_2m"))),
        "precipitationProbability": js_round(at(hourly.get("precipitation_probability")), 0),
        "weather": weather_text(at(hourly.get("weather_code"))),
        "windSpeed": js_round(at(hourly.get("wind_speed_10m"))),
    }


class VenueWeatherService:
    def __init__(self) -> None:
        settings = config.open_meteo_settings()
        self.geocoding_base = settings["geocodingBase"]
        self.forecast_base = settings["forecastBase"]
        self.llm = llm_config()
        self.venue_cache = TtlCache(7 * 24 * 60 * 60 * 1000, 500)
        self.venue_miss_cache = TtlCache(10 * 60 * 1000, 500)
        self.weather_cache = TtlCache(20 * 60 * 1000, 500)
        # 城市解析只是天气的前置步骤，不该让用户等满整段大模型超时
        self.resolver_timeout_ms = min(self.llm["timeoutMs"], 15_000)

    def _ask_model(self, home_team: str, league: str) -> dict | None:
        if not self.llm["apiKey"]:
            return None
        result = chat_completion(
            self.llm,
            {
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": f"主队：{home_team}\n联赛：{league or '未知'}"},
                ],
                "json": True,
                "thinking": False,
                "maxTokens": 200,
                "temperature": 0,
                "timeoutMs": self.resolver_timeout_ms,
            },
        )

        text = re.sub(r"^```(?:json)?\s*", "", result["content"].strip(), flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)
        try:
            parsed = json.loads(text)
        except ValueError:
            return None
        if not isinstance(parsed, dict) or not isinstance(parsed.get("city"), str):
            return None

        city = parsed["city"].strip()
        country = parsed["country"].strip() if isinstance(parsed.get("country"), str) else ""
        confidence = parsed.get("confidence") if isinstance(parsed.get("confidence"), str) else ""
        if not _CITY_PATTERN.match(city):
            return None
        if confidence == "low":
            return None
        return {
            "city": city,
            "country": country,
            "stadium": parsed["stadium"].strip()[:120] if isinstance(parsed.get("stadium"), str) else "",
            "confidence": confidence,
        }

    def _geocode(self, city: str, country: str) -> dict | None:
        query = urllib.parse.urlencode(
            {"name": city, "count": "10", "language": "en", "format": "json"}
        )
        payload = _fetch_json(f"{self.geocoding_base}/v1/search?{query}", 8_000)
        result = pick_geocode_result(payload.get("results"), normalize(country))
        if not result:
            return None
        return {
            "city": result.get("name"),
            "country": result.get("country"),
            "countryCode": result.get("country_code"),
            "latitude": result.get("latitude"),
            "longitude": result.get("longitude"),
            "timezone": result.get("timezone") or "",
        }

    def _resolve_venue(self, home_team: str, league: str) -> dict | None:
        if not self.llm["apiKey"]:
            return None
        resolution = self._ask_model(home_team, league)
        if not resolution:
            return None
        location = self._geocode(resolution["city"], resolution["country"])
        if not location:
            return None
        return {**location, "stadium": resolution["stadium"], "confidence": resolution["confidence"]}

    def _fetch_forecast(self, venue: dict, kickoff: Any) -> dict:
        query = urllib.parse.urlencode(
            {
                "latitude": str(venue["latitude"]),
                "longitude": str(venue["longitude"]),
                "current": "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,"
                "weather_code,wind_speed_10m,wind_direction_10m",
                "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
                "hourly": "temperature_2m,precipitation_probability,weather_code,wind_speed_10m",
                "timezone": "auto",
                "forecast_days": "16",
            }
        )
        payload = _fetch_json(f"{self.forecast_base}/v1/forecast?{query}", 12_000)

        daily_payload = (payload or {}).get("daily") or {}
        days = daily_payload.get("time") or []
        daily = [
            {
                "date": date,
                "weather": weather_text((daily_payload.get("weather_code") or [None] * len(days))[index]),
                "tempMax": js_round((daily_payload.get("temperature_2m_max") or [None] * len(days))[index]),
                "tempMin": js_round((daily_payload.get("temperature_2m_min") or [None] * len(days))[index]),
                "precipitationProbability": js_round(
                    (daily_payload.get("precipitation_probability_max") or [None] * len(days))[index], 0
                ),
            }
            for index, date in enumerate(days[:3])
        ]

        current = (payload or {}).get("current") or {}
        return {
            "timezone": (payload or {}).get("timezone") or venue.get("timezone") or "",
            "current": {
                "temperature": js_round(current.get("temperature_2m")),
                "apparentTemperature": js_round(current.get("apparent_temperature")),
                "humidity": js_round(current.get("relative_humidity_2m"), 0),
                "precipitation": js_round(current.get("precipitation")),
                "windSpeed": js_round(current.get("wind_speed_10m")),
                "windDirection": js_round(current.get("wind_direction_10m"), 0),
                "weather": weather_text(current.get("weather_code")),
                "weatherCode": current.get("weather_code"),
                "time": current.get("time") or "",
            },
            "daily": daily,
            "kickoff": build_kickoff_forecast(payload, kickoff),
            "source": "open-meteo",
        }

    def get(self, *, team_id: int | None, home_team: str, league: str, kickoff: Any) -> dict:
        if not home_team:
            return {"available": False, "reason": "缺少主队名称"}

        venue_key = f"id:{team_id}" if team_id else f"name:{home_team}"
        venue, hit = self.venue_cache.get(venue_key)

        if not hit:
            miss, miss_hit = self.venue_miss_cache.get(venue_key)
            if miss_hit:
                return {"available": False, "reason": miss}

            try:
                venue = self._resolve_venue(home_team, league)
            except AnalysisError as error:
                print(f"[venue] 城市解析失败：{error.message}", flush=True)
                return {"available": False, "reason": "比赛地天气服务暂时不可用"}

            if not venue:
                reason = (
                    "无法确认主队所在城市"
                    if self.llm["apiKey"]
                    else "服务端未配置 DEEPSEEK_API_KEY，无法解析比赛地"
                )
                self.venue_miss_cache.set(venue_key, reason)
                return {"available": False, "reason": reason}

            self.venue_cache.set(venue_key, venue)

        weather_key = f"{float(venue['latitude']):.2f},{float(venue['longitude']):.2f},{str(kickoff or '')[:13]}"
        weather, weather_hit = self.weather_cache.get(weather_key)
        if not weather_hit:
            try:
                weather = self._fetch_forecast(venue, kickoff)
            except AnalysisError as error:
                print(f"[venue] 天气获取失败：{error.message}", flush=True)
                return {"available": False, "reason": "比赛地天气获取失败"}
            self.weather_cache.set(weather_key, weather)

        return {"available": True, **venue, **weather}


_service: VenueWeatherService | None = None


def get_venue_service() -> VenueWeatherService:
    global _service
    if _service is None:
        _service = VenueWeatherService()
    return _service
