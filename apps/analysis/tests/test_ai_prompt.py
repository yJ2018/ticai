"""AI 分析提示词与 Node 版对拍（逐字节）。

夹具由 `node scripts/export-ai-fixtures.mjs` 生成：一条真实比赛上下文 + 5 种玩法提示词 +
带天气的混合玩法 + 一个串关提示词。LLM 输出不参与对拍，这里只验证「喂给模型的文本」一致——
提示词一旦漂移，两套实现的输出风格和 token 成本都会悄悄分叉。
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from app.ai.parlay_prompt import build_parlay_prompt
from app.ai.prompt import POOL_KEYS, build_analysis_prompt

FIXTURE = Path(__file__).parent / "fixtures" / "ai-prompt-parity.json"


@unittest.skipUnless(FIXTURE.is_file(), "缺少对拍夹具：先跑 node scripts/export-ai-fixtures.mjs")
class AiPromptParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        with FIXTURE.open(encoding="utf-8") as handle:
            cls.fixture = json.load(handle)

    def build_single(self, pool: str, weather=None) -> dict:
        context = self.fixture["context"]
        return build_analysis_prompt(
            match=context["match"],
            odds=context["odds"],
            feeds=context.get("feeds") or {},
            lineup=context.get("lineup"),
            weather=weather,
            pool=pool,
        )

    def test_single_prompts_match_node(self) -> None:
        for pool in POOL_KEYS:
            expected = self.fixture["single"][pool]
            actual = self.build_single(pool)
            with self.subTest(pool=pool):
                self.assertEqual(actual["system"], expected["system"], f"{pool} system 不一致")
                self.assertEqual(actual["user"], expected["user"], f"{pool} user 不一致")
                self.assertEqual(actual["chars"], expected["chars"], f"{pool} chars 不一致")

    def test_single_prompt_with_weather_matches_node(self) -> None:
        expected = self.fixture["singleWithWeather"]
        actual = self.build_single("mixed", weather=self.fixture["weather"])
        self.assertEqual(actual["user"], expected["user"])
        self.assertEqual(actual["chars"], expected["chars"])

    def test_parlay_prompt_matches_node(self) -> None:
        expected = self.fixture["parlay"]
        payload = expected["input"]
        actual = build_parlay_prompt(
            pool=payload["pool"],
            pass_summary_text=payload["passSummaryText"],
            bet_amount=payload["betAmount"],
            max_bonus=payload["maxBonus"],
            legs=payload["legs"],
        )
        self.assertEqual(actual["system"], expected["system"])
        self.assertEqual(actual["user"], expected["user"])
        self.assertEqual(actual["chars"], expected["chars"])


if __name__ == "__main__":
    unittest.main()
