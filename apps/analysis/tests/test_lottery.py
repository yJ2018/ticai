"""开奖分析（Python）与 Node 版的对拍。

夹具由 `node scripts/export-lottery-fixtures.mjs` 生成：截断后的真实开奖 + Node 算出的 payload。
两边口径必须完全一致——字段、排序、四舍五入都一样，浮点容差 1e-9。
"""

from __future__ import annotations

import json
import math
import unittest
from pathlib import Path

from app.analysis.configs import math_trend_config_key, parse_prediction_config_key, prediction_config_key
from app.analysis.dlt import analyze_dlt_recommendation
from app.analysis.prediction import analyze_history_prediction, analyze_math_trend_prediction

FIXTURE = Path(__file__).parent / "fixtures" / "lottery-parity.json"


def assert_deep_equal(case: unittest.TestCase, actual, expected, path: str = "root", tol: float = 1e-9) -> None:
    if isinstance(expected, dict):
        case.assertIsInstance(actual, dict, path)
        case.assertEqual(list(actual.keys()), list(expected.keys()), f"{path} 字段/顺序不一致")
        for key, value in expected.items():
            assert_deep_equal(case, actual[key], value, f"{path}.{key}", tol)
        return

    if isinstance(expected, list):
        case.assertIsInstance(actual, list, path)
        case.assertEqual(len(actual), len(expected), f"{path} 长度不一致")
        for index, value in enumerate(expected):
            assert_deep_equal(case, actual[index], value, f"{path}[{index}]", tol)
        return

    if isinstance(expected, bool) or expected is None:
        case.assertEqual(actual, expected, path)
        return

    if isinstance(expected, (int, float)):
        case.assertIsInstance(actual, (int, float), path)
        if isinstance(expected, float) or isinstance(actual, float):
            case.assertTrue(
                math.isfinite(actual) and abs(actual - expected) <= tol + tol * abs(expected),
                f"{path}: python={actual} node={expected}",
            )
        else:
            case.assertEqual(actual, expected, path)
        return

    case.assertEqual(actual, expected, path)


@unittest.skipUnless(FIXTURE.is_file(), "缺少对拍夹具：先跑 node scripts/export-lottery-fixtures.mjs")
class LotteryParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        with FIXTURE.open(encoding="utf-8") as handle:
            cls.fixture = json.load(handle)

    def test_prediction_payloads_match_node(self) -> None:
        for game_key, pack in self.fixture["games"].items():
            draws = pack["draws"]
            position_count = pack["game"]["mainCount"] or 5
            for key, expected in pack["expected"].items():
                kind, config_key = key.split(":", 1)
                if kind != "prediction":
                    continue
                options = {**parse_prediction_config_key(config_key), "positionCount": position_count}
                actual = analyze_history_prediction(draws, options)
                with self.subTest(game=game_key, config=config_key):
                    assert_deep_equal(self, actual, expected, f"{game_key}.{config_key}")

    def test_math_trend_payloads_match_node(self) -> None:
        for game_key, pack in self.fixture["games"].items():
            draws = pack["draws"]
            for key, expected in pack["expected"].items():
                kind, config_key = key.split(":", 1)
                if kind != "math_trend":
                    continue
                actual = analyze_math_trend_prediction(draws, {})
                with self.subTest(game=game_key, config=config_key):
                    assert_deep_equal(self, actual, expected, f"{game_key}.{config_key}")

    def test_dlt_payloads_match_node(self) -> None:
        for game_key, pack in self.fixture["games"].items():
            draws = pack["draws"]
            for key, expected in pack["expected"].items():
                kind, config_key = key.split(":", 1)
                if kind != "dlt":
                    continue
                actual = analyze_dlt_recommendation([{"numbers": draw["numbers"]} for draw in draws])
                with self.subTest(game=game_key, config=config_key):
                    assert_deep_equal(self, actual, expected, f"{game_key}.{config_key}")

    def test_config_keys_round_trip(self) -> None:
        """config_key 是快照的主键维度，Python 必须生成与 Node 完全一样的字符串。"""
        for order in (1, 2, 3, 4, 5):
            self.assertEqual(prediction_config_key({"markovOrder": order}), f"markov={order}")
        self.assertEqual(prediction_config_key(), "markov=2")
        self.assertEqual(
            math_trend_config_key(),
            "window=240;trend=36;validate=120;candidates=3",
        )
        parsed = parse_prediction_config_key("markov=3;w=34-20-22-14-10")
        self.assertEqual(parsed["markovOrder"], 3)
        self.assertAlmostEqual(parsed["scoreWeights"]["recent"], 0.34)
