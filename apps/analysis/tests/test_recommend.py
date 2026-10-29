"""推荐引擎（Python）与 Node 版的单测 + 对拍。

    apps/analysis/.venv/Scripts/python.exe -m unittest discover -s apps/analysis/tests -t apps/analysis

对拍夹具由 `node scripts/export-analysis-fixtures.mjs` 生成：同一批赔率/伤停/历史，
两套实现应当给出同样的方案与概率（概率容差 5e-3，键与文案要求一致）。
"""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timezone
from pathlib import Path

from app.recommend.backtest import run_backtest
from app.recommend.engine import build_recommendation
from app.recommend.mathx import devig, fit_lambdas, poisson_pmf, pool_probabilities, score_matrix
from app.recommend.odds import market_probabilities, option_label, read_pools

FIXTURE = Path(__file__).parent / "fixtures" / "recommend-parity.json"


class MathTests(unittest.TestCase):
    def test_poisson_sums_to_one(self) -> None:
        pmf = poisson_pmf(1.7, 8)
        self.assertAlmostEqual(sum(pmf), 1, places=3)
        mean = sum(value * index for index, value in enumerate(pmf))
        self.assertAlmostEqual(mean, 1.7, places=2)

    def test_devig_fair_two_way(self) -> None:
        probs = devig([2, 2])
        self.assertIsNotNone(probs)
        self.assertAlmostEqual(probs[0], 0.5, places=9)

    def test_devig_power_method_lowers_longshot(self) -> None:
        odds = [1.35, 4.8, 9.5]
        power = devig(odds)
        raw = [1 / value for value in odds]
        total = sum(raw)
        proportional = [value / total for value in raw]
        self.assertGreater(power[0], proportional[0])
        self.assertLess(power[2], proportional[2])
        self.assertAlmostEqual(sum(power), 1, places=9)

    def test_score_matrix_normalizes(self) -> None:
        matrix = score_matrix(1.4, 1.1)
        total = sum(sum(row) for row in matrix)
        self.assertAlmostEqual(total, 1, places=9)
        plain = score_matrix(1.4, 1.1, rho=0)
        self.assertGreater(matrix[0][0], plain[0][0])
        self.assertLess(matrix[1][0], plain[1][0])

    def test_pool_probabilities(self) -> None:
        matrix = score_matrix(1.5, 1.1)
        probs = pool_probabilities(matrix, 1)
        had_total = probs["had"]["h"] + probs["had"]["d"] + probs["had"]["a"]
        self.assertAlmostEqual(had_total, 1, places=9)
        plain = pool_probabilities(matrix, 0)
        self.assertGreater(probs["hhad"]["h"], plain["hhad"]["h"])
        self.assertGreater(probs["ttg"]["s7"], 0)

    def test_fit_lambdas_recovers_truth(self) -> None:
        truth = {"home": 1.65, "away": 1.05}
        probs = pool_probabilities(score_matrix(truth["home"], truth["away"]), 0)
        fit = fit_lambdas(probs["had"], probs["ttg"], 0)
        self.assertIsNotNone(fit)
        self.assertAlmostEqual(fit["home"], truth["home"], delta=0.12)
        self.assertAlmostEqual(fit["away"], truth["away"], delta=0.12)

    def test_option_labels(self) -> None:
        self.assertEqual(option_label("had", "h"), "胜")
        self.assertEqual(option_label("hhad", "a", -1), "让球(-1) 负")
        self.assertEqual(option_label("hhad", "h", 1), "让球(+1) 胜")
        self.assertEqual(option_label("ttg", "s7"), "总进球 7+")
        self.assertEqual(option_label("ttg", "s2"), "总进球 2")


class EngineRiskControlTests(unittest.TestCase):
    """守「不要瞎来」：赔率上限、串关长度、命中率下限、长赔不入方案。"""

    TTG = [12, 4.8, 3.4, 3.6, 5.2, 9, 15, 22]
    NOW = datetime(2026, 10, 29, 8, 0, tzinfo=timezone.utc)

    def make_odds(self, had, hhad, line="", ttg=None):
        ttg = ttg or self.TTG
        return {
            "had": {"h": str(had[0]), "d": str(had[1]), "a": str(had[2])},
            "hhad": {"h": str(hhad[0]), "d": str(hhad[1]), "a": str(hhad[2]), "goalLine": line, "goalLineValue": line},
            "ttg": {f"s{index}": str(value) for index, value in enumerate(ttg)},
        }

    def make_match(self, match_id, odds, **overrides):
        match = {
            "matchId": match_id,
            "matchNo": f"周四00{match_id % 10}",
            "league": overrides.pop("league", f"联赛{match_id}"),
            "homeName": f"主队{match_id}",
            "awayName": f"客队{match_id}",
            "kickoffAt": "2026-10-29T11:00:00.000Z",
            "businessDate": "2026-10-29",
            "homeTeamId": match_id * 10,
            "awayTeamId": match_id * 10 + 1,
            "odds": odds,
            "oddsCapturedAt": "2026-10-29T09:00:00.000Z",
        }
        match.update(overrides)
        return match

    def favourite_odds(self):
        return self.make_odds([1.35, 4.8, 8.0], [2.1, 3.4, 3.2], "+1")

    def test_plans_respect_caps(self) -> None:
        slate = [self.make_match(index, self.favourite_odds()) for index in (1, 2, 3, 4)]
        data = build_recommendation(slate=slate, finished=[], pool="had", scope="today", now=self.NOW)
        self.assertGreater(len(data["plans"]), 0)
        for plan in data["plans"]:
            self.assertLessEqual(len(plan["legs"]), 3)
            self.assertLessEqual(plan["totalOdd"], 8.01)
            for leg in plan["legs"]:
                self.assertGreaterEqual(leg["odd"], 1.2)
                self.assertLessEqual(leg["odd"], 4.51)
                self.assertGreaterEqual(leg["blendP"], 0.2)
            if plan["id"] == "safe":
                self.assertEqual(len(plan["legs"]), 2)
                self.assertGreaterEqual(plan["hitProb"], 0.26)
            if plan["id"] == "aggressive":
                self.assertEqual(len(plan["legs"]), 3)
                self.assertGreaterEqual(plan["hitProb"], 0.15)
            self.assertLess(plan["hitProb"] * plan["totalOdd"], 1.2)

    def test_longshot_never_selected(self) -> None:
        odds = self.make_odds([1.28, 5.2, 11.0], [2.3, 3.3, 3.1], "+1")
        slate = [self.make_match(index, odds) for index in (1, 2, 3)]
        data = build_recommendation(slate=slate, finished=[], pool="mixed", scope="today", now=self.NOW)
        for plan in data["plans"]:
            for leg in plan["legs"]:
                self.assertLessEqual(leg["odd"], 3.61, f"长赔混进了方案：{leg['optionLabel']} @{leg['odd']}")

    def test_no_fake_edge_without_data(self) -> None:
        slate = [self.make_match(index, self.favourite_odds()) for index in (1, 2)]
        data = build_recommendation(slate=slate, finished=[], pool="had", scope="today", now=self.NOW)
        for plan in data["plans"]:
            for leg in plan["legs"]:
                self.assertLessEqual(leg["weight"], 0.05)
                self.assertLess(abs(leg["blendP"] - leg["marketP"]), 0.005)
                self.assertLess(leg["edge"], 0)

    def test_no_plan_below_threshold(self) -> None:
        odds = self.make_odds([1.15, 7.5, 15], [1.4, 4.6, 6.2], "+1")
        slate = [self.make_match(index, odds) for index in (1, 2, 3)]
        data = build_recommendation(slate=slate, finished=[], pool="had", scope="today", now=self.NOW)
        self.assertEqual(data["plans"], [])
        self.assertTrue(any("没有达到门槛" in note for note in data["notes"]))

    def test_scope_today_excludes_other_days(self) -> None:
        slate = [
            self.make_match(1, self.favourite_odds()),
            self.make_match(2, self.favourite_odds()),
            self.make_match(3, self.favourite_odds(), businessDate="2026-10-30"),
        ]
        data = build_recommendation(slate=slate, finished=[], pool="had", scope="today", now=self.NOW)
        self.assertEqual(data["coverage"]["inScope"], 2)
        ids = [leg["matchId"] for plan in data["plans"] for leg in plan["legs"]]
        self.assertNotIn(3, ids)

    def test_crs_pool_not_recommended(self) -> None:
        data = build_recommendation(
            slate=[self.make_match(1, self.favourite_odds())], finished=[], pool="crs", scope="today", now=self.NOW
        )
        self.assertEqual(data["plans"], [])
        self.assertTrue(any("比分" in note for note in data["notes"]))


@unittest.skipUnless(FIXTURE.is_file(), "缺少对拍夹具：先跑 node scripts/export-analysis-fixtures.mjs")
class ParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        with FIXTURE.open(encoding="utf-8") as handle:
            cls.fixture = json.load(handle)
        cls.now = datetime.fromisoformat(cls.fixture["now"].replace("Z", "+00:00"))
        cls.injuries = {int(key): value for key, value in cls.fixture["injuries"].items()}

    def run_node(self, pool: str) -> dict:
        return build_recommendation(
            slate=self.fixture["slate"],
            injuries=self.injuries,
            finished=self.fixture["finished"],
            pool=pool,
            scope="today",
            now=self.now,
        )

    def assert_close(self, actual: float, expected: float, label: str, tol: float = 5e-3) -> None:
        self.assertLessEqual(abs(actual - expected), tol, f"{label}: python={actual} node={expected}")

    def test_coverage_and_filtered_match(self) -> None:
        for pool in ("had", "mixed", "ttg"):
            expected = self.fixture["expected"][pool]
            actual = self.run_node(pool)
            self.assertEqual(actual["coverage"], expected["coverage"], pool)
            self.assertEqual(actual["filtered"], expected["filtered"], pool)
            self.assertEqual(actual["notes"], expected["notes"], pool)
            self.assertEqual(actual["poolLabel"], expected["poolLabel"], pool)

    def test_plans_match(self) -> None:
        for pool in ("had", "mixed", "ttg"):
            expected = self.fixture["expected"][pool]
            actual = self.run_node(pool)
            self.assertEqual([plan["id"] for plan in actual["plans"]], [plan["id"] for plan in expected["plans"]], pool)

            for actual_plan, expected_plan in zip(actual["plans"], expected["plans"]):
                self.assertEqual(actual_plan["label"], expected_plan["label"])
                self.assertEqual(len(actual_plan["legs"]), len(expected_plan["legs"]))
                self.assert_close(actual_plan["totalOdd"], expected_plan["totalOdd"], f"{pool} totalOdd")
                self.assert_close(actual_plan["hitProb"], expected_plan["hitProb"], f"{pool} hitProb")
                self.assert_close(
                    actual_plan["expectedReturn"], expected_plan["expectedReturn"], f"{pool} expectedReturn"
                )
                for actual_leg, expected_leg in zip(actual_plan["legs"], expected_plan["legs"]):
                    self.assertEqual(actual_leg["matchId"], expected_leg["matchId"], f"{pool} leg match")
                    self.assertEqual(actual_leg["optionKey"], expected_leg["optionKey"], f"{pool} leg key")
                    self.assertEqual(actual_leg["optionLabel"], expected_leg["optionLabel"], f"{pool} leg label")
                    self.assert_close(actual_leg["odd"], expected_leg["odd"], f"{pool} leg odd", 1e-9)
                    self.assert_close(actual_leg["marketP"], expected_leg["marketP"], f"{pool} marketP")
                    self.assert_close(actual_leg["modelP"], expected_leg["modelP"], f"{pool} modelP")
                    self.assert_close(actual_leg["blendP"], expected_leg["blendP"], f"{pool} blendP")
                    self.assert_close(actual_leg["edge"], expected_leg["edge"], f"{pool} edge")
                    self.assert_close(actual_leg["weight"], expected_leg["weight"], f"{pool} weight", 1e-9)

    def test_candidates_match(self) -> None:
        for pool in ("had", "mixed", "ttg"):
            expected = self.fixture["expected"][pool]["candidates"]
            actual = self.run_node(pool)["candidates"]
            self.assertEqual(
                [(item["matchId"], item["optionKey"]) for item in actual],
                [(item["matchId"], item["optionKey"]) for item in expected],
                pool,
            )
            for actual_item, expected_item in zip(actual, expected):
                self.assert_close(actual_item["blendP"], expected_item["blendP"], f"{pool} candidate blendP")
                self.assert_close(actual_item["modelP"], expected_item["modelP"], f"{pool} candidate modelP")
                self.assertEqual(actual_item["passSafe"], expected_item["passSafe"], pool)

    def test_backtest_matches(self) -> None:
        expected = self.fixture["backtest"]
        actual = run_backtest(self.fixture["backtestSamples"])
        self.assertEqual(actual["window"], expected["window"])
        for key in ("singles", "doubles", "longshot", "wideSingles"):
            for field in ("n", "hits"):
                self.assertEqual(actual[key][field], expected[key][field], f"{key}.{field}")
            for field in ("hitRate", "roi", "avgOdd"):
                self.assert_close(actual[key][field], expected[key][field], f"{key}.{field}", 1e-6)
        self.assertEqual([band["label"] for band in actual["bands"]], [band["label"] for band in expected["bands"]])
        for actual_band, expected_band in zip(actual["bands"], expected["bands"]):
            self.assertEqual(actual_band["n"], expected_band["n"], actual_band["label"])
            self.assert_close(actual_band["hitRate"], expected_band["hitRate"], f"band {actual_band['label']}", 1e-6)


if __name__ == "__main__":
    unittest.main()
