"""比赛地天气（Python）的纯函数单测。

只覆盖不依赖外网的解析逻辑：北京时间换算、Open-Meteo 预报对齐、国家名归一、地理编码挑选。
真正的 DeepSeek / Open-Meteo 调用在本地冒烟里验证，不进入单测（不该让 CI 依赖外网与模型额度）。
"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

from app.venue import (
    TtlCache,
    build_kickoff_forecast,
    country_matches,
    js_round,
    normalize,
    parse_beijing_kickoff,
    pick_geocode_result,
    weather_text,
)


class WeatherTextTests(unittest.TestCase):
    def test_known_and_unknown_codes(self) -> None:
        self.assertEqual(weather_text(0), "晴")
        self.assertEqual(weather_text(3), "阴")
        self.assertEqual(weather_text(95), "雷暴")
        self.assertEqual(weather_text(999), "未知天气")
        self.assertEqual(weather_text(None), "未知天气")


class RoundingTests(unittest.TestCase):
    def test_js_round_matches_math_round(self) -> None:
        self.assertEqual(js_round(1.25, 1), 1.3)
        self.assertEqual(js_round(1.24, 1), 1.2)
        self.assertEqual(js_round(20.4, 0), 20)
        self.assertIsNone(js_round("abc"))


class NormalizeTests(unittest.TestCase):
    def test_strips_accents_and_punctuation(self) -> None:
        self.assertEqual(normalize("São Paulo"), "sao paulo")
        self.assertEqual(normalize("  St.  Étienne "), "st etienne")
        self.assertEqual(normalize(None), "")

    def test_country_aliases(self) -> None:
        self.assertTrue(country_matches({"country": "United Kingdom"}, "uk"))
        self.assertTrue(country_matches({"country": "Italy"}, "italy"))
        self.assertTrue(country_matches({"country": "anything"}, ""))
        self.assertFalse(country_matches({"country": "Italy"}, "sweden"))
        self.assertTrue(country_matches({"country_code": "US"}, "united states"))


class KickoffTests(unittest.TestCase):
    def test_beijing_kickoff_is_utc_minus_eight(self) -> None:
        epoch = parse_beijing_kickoff("2026-10-29 20:00")
        self.assertIsNotNone(epoch)
        moment = datetime.fromtimestamp(epoch, tz=timezone.utc)
        self.assertEqual(moment.strftime("%Y-%m-%dT%H:%M"), "2026-10-29T12:00")
        self.assertIsNone(parse_beijing_kickoff("not-a-date"))

    def test_builds_hourly_snapshot_from_local_offset(self) -> None:
        payload = {
            "utc_offset_seconds": 3600,
            "hourly": {
                "time": ["2026-10-29T12:00", "2026-10-29T13:00", "2026-10-29T14:00"],
                "temperature_2m": [10.0, 12.5, 13.0],
                "precipitation_probability": [0, 20, 30],
                "weather_code": [1, 3, 61],
                "wind_speed_10m": [5.0, 7.55, 8.0],
            },
        }
        snapshot = build_kickoff_forecast(payload, "2026-10-29 20:00")
        self.assertIsNotNone(snapshot)
        assert snapshot is not None
        self.assertEqual(snapshot["time"], "2026-10-29T13:00")
        self.assertEqual(snapshot["forecastTime"], "2026-10-29T13:00")
        self.assertEqual(snapshot["temperature"], 12.5)
        self.assertEqual(snapshot["precipitationProbability"], 20)
        self.assertEqual(snapshot["weather"], "阴")
        # 7.55*10 在双精度里正好落在 75.5，JS Math.round 与这里的 floor(x+0.5) 都进位到 7.6
        self.assertEqual(snapshot["windSpeed"], 7.6)

    def test_missing_hour_returns_none(self) -> None:
        payload = {"utc_offset_seconds": 0, "hourly": {"time": ["2026-10-30T00:00"]}}
        self.assertIsNone(build_kickoff_forecast(payload, "2026-10-29 20:00"))
        self.assertIsNone(build_kickoff_forecast({"hourly": {"time": []}}, "2026-10-29 20:00"))


class GeocodeTests(unittest.TestCase):
    def test_picks_largest_population_in_matching_country(self) -> None:
        results = [
            {"name": "Small", "country": "Italy", "population": 10},
            {"name": "Big", "country": "Italy", "population": 1000},
            {"name": "Elsewhere", "country": "France", "population": 99999},
        ]
        self.assertEqual(pick_geocode_result(results, "italy")["name"], "Big")
        self.assertIsNone(pick_geocode_result(results, "sweden"))
        self.assertIsNone(pick_geocode_result([], "italy"))


class CacheTests(unittest.TestCase):
    def test_ttl_cache_hits_then_expires(self) -> None:
        cache = TtlCache(ttl_ms=50, max_entries=2)
        cache.set("a", 1)
        value, hit = cache.get("a")
        self.assertTrue(hit)
        self.assertEqual(value, 1)
        self.assertEqual(cache.get("missing"), (None, False))

    def test_ttl_cache_evicts_oldest(self) -> None:
        cache = TtlCache(ttl_ms=60_000, max_entries=2)
        cache.set("a", 1)
        cache.set("b", 2)
        cache.set("c", 3)
        self.assertEqual(cache.get("a"), (None, False))
        self.assertTrue(cache.get("c")[1])


if __name__ == "__main__":
    unittest.main()
