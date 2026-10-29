"""位置型彩种的预测 / 走势分析（Python 移植，逐行对齐 history-prediction.mjs）。

源算法：`src/domain/historyPrediction.ts` → `scripts/sync-analysis.mjs` 生成 Node 版；
这里按同一口径用 Python 重写，输出结构（字段名、顺序、四舍五入）与 Node 完全一致，
差异只允许出现在浮点末位（对拍容差 1e-9）。

口径要点（不能凭直觉改）：
- 窗口是「最近 N 期」，输入按时间正序；
- 打分 = 近窗频率 + 长窗频率 + 遗漏 + 转移 + 二阶转移，各乘权重后 ×100，再保留 1 位小数；
- 所有排序都是多级稳定排序：分数 → 近期次数 → 长期次数 → 遗漏 → 数字升序；
- JS 的 `Math.round` 是四舍五入到 +∞（不是银行家舍入），这里用 floor(x + 0.5) 复刻。
"""

from __future__ import annotations

import math
import re
from typing import Any

DIGITS = list(range(10))
POSITION_COUNT = 5
RECENT_WINDOW = 12
LONG_WINDOW = 60
MIN_TRAINING_SIZE = 30
COMBINATION_POOL_SIZE = 3
COMBINATION_LIMIT = 6
DEFAULT_MARKOV_ORDER = 2
MATH_SAMPLE_WINDOW = 240
MATH_TREND_WINDOW = 36
MATH_VALIDATION_START = 120
MATH_CANDIDATE_COUNT = 3
MATH_RECENT_DIGIT_COUNT = 18

DEFAULT_PREDICTION_SCORE_WEIGHTS = {
    "recent": 0.34,
    "long": 0.2,
    "omission": 0.22,
    "transition": 0.14,
    "pairTransition": 0.1,
}

_DIGIT_PATTERN = re.compile(r"^\d$")


def _js_round(value: float) -> int:
    """JS Math.round：四舍五入到 +∞（-0.5 → -0，0.5 → 1）。"""
    return math.floor(value + 0.5)


def round_score(value: float) -> float:
    return _js_round(value * 10) / 10


def _to_bounded_integer(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(numeric):
        return fallback
    return min(max(math.floor(numeric), minimum), maximum)


def _clamp_number(value: float, minimum: float, maximum: float) -> float:
    return min(max(value, minimum), maximum)


def _clamp_zero_to_one(value: float) -> float:
    return _clamp_number(value, 0, 1)


def _safe_rate(value: float, total: float) -> float:
    return 0.0 if total <= 0 else value / total


def _average_number(values: list[float]) -> float:
    return 0.0 if not values else sum(values) / len(values)


def _average_rate(values: list[float]) -> float:
    valid = [value for value in values if math.isfinite(value) and value > 0]
    return 0.0 if not valid else sum(valid) / len(valid)


def _normalize_score_weights(weights: dict[str, Any]) -> dict[str, float]:
    sanitized = {
        key: (float(value) if isinstance(value, (int, float)) and math.isfinite(value) and value > 0 else 0.0)
        for key, value in weights.items()
    }
    total = sum(sanitized.values())
    if total <= 0:
        return dict(DEFAULT_PREDICTION_SCORE_WEIGHTS)
    return {key: sanitized[key] / total for key in DEFAULT_PREDICTION_SCORE_WEIGHTS}


def parse_digit_value(value: Any) -> int | None:
    if not isinstance(value, str) or not _DIGIT_PATTERN.match(value):
        return None
    return int(value)


def sort_chronological(entries: list[dict]) -> list[dict]:
    items = list(entries)
    try:
        numeric = [float(entry["issue"]) for entry in items]
        can_sort = all(math.isfinite(value) for value in numeric)
    except (KeyError, TypeError, ValueError):
        can_sort = False
    if can_sort:
        return [entry for _, entry in sorted(zip(numeric, items), key=lambda pair: pair[0])]
    return list(reversed(items))


def count_digits(values: list[int]) -> list[int]:
    counts = [0] * 10
    for value in values:
        counts[value] += 1
    return counts


def sum_counts(values: list[int]) -> int:
    return sum(values)


def count_transition_matches(values: list[int], pattern: list[int]) -> list[int]:
    counts = [0] * 10
    length = len(pattern)
    if len(values) <= length:
        return counts
    for index in range(length, len(values)):
        matched = True
        for offset in range(length):
            if values[index - length + offset] != pattern[offset]:
                matched = False
                break
        if matched:
            counts[values[index]] += 1
    return counts


def get_miss_span(values: list[int], digit: int) -> int:
    for index in range(len(values) - 1, -1, -1):
        if values[index] == digit:
            return len(values) - 1 - index
    return len(values)


def get_draw_miss_span(draws: list[list[int]], digit: int) -> int:
    for index in range(len(draws) - 1, -1, -1):
        if digit in draws[index]:
            return len(draws) - 1 - index
    return len(draws)


def _increment(counts: dict[str, int], key: str) -> None:
    counts[key] = counts.get(key, 0) + 1


def _build_top_buckets(counts: dict[str, int], total: int, limit: int) -> list[dict]:
    items = [
        {"label": label, "count": count, "rate": _safe_rate(count, total)}
        for label, count in counts.items()
    ]
    items.sort(key=lambda item: (-item["count"], item["label"]))
    return items[:limit]


class _DigitStream:
    """增量统计器：逐期喂入数字，随时给出「已看过的前缀」上的排名所需计数。

    Node 版每个回测样本都重扫一遍历史（O(n²)），7762 期要 1.5s；
    Python 直接照搬是 64s。这里把「转移计数 / 各数字出现次数 / 最近一次出现位置」
    都改成增量维护，单次回测从 O(n²) 降到 O(n)。
    """

    MAX_ORDER = 5

    def __init__(self, recent_window: int, long_window: int) -> None:
        self.values: list[int] = []
        self.total = [0] * 10
        self.last_seen = [-1] * 10
        self.recent_counts = [0] * 10
        self.long_counts = [0] * 10
        self.recent_window = recent_window
        self.long_window = long_window
        self._recent_queue: list[int] = []
        self._long_queue: list[int] = []
        # trans[order][pattern] = 以 pattern 结尾之后那一位的计数（下一期下标 <= 当前末尾）
        self.trans: list[dict[tuple[int, ...], list[int]]] = [dict() for _ in range(self.MAX_ORDER + 1)]

    def append(self, value: int) -> None:
        index = len(self.values)
        self.values.append(value)
        self.total[value] += 1
        self.last_seen[value] = index

        self._recent_queue.append(value)
        self.recent_counts[value] += 1
        if len(self._recent_queue) > self.recent_window:
            dropped = self._recent_queue.pop(0)
            self.recent_counts[dropped] -= 1

        self._long_queue.append(value)
        self.long_counts[value] += 1
        if len(self._long_queue) > self.long_window:
            dropped = self._long_queue.pop(0)
            self.long_counts[dropped] -= 1

        for order in range(1, min(self.MAX_ORDER, index) + 1):
            pattern = tuple(self.values[index - order : index])
            counts = self.trans[order].get(pattern)
            if counts is None:
                counts = [0] * 10
                self.trans[order][pattern] = counts
            counts[value] += 1

    def window_counts(self, window: str) -> list[int]:
        return self.recent_counts if window == "recent" else self.long_counts

    def miss_span(self, digit: int) -> int:
        seen = self.last_seen[digit]
        return len(self.values) if seen < 0 else len(self.values) - 1 - seen

    def transition_counts(self, pattern: list[int]) -> list[int]:
        counts = self.trans[len(pattern)].get(tuple(pattern))
        return counts if counts is not None else [0] * 10


def _stream_from(history_digits: list[int], config: dict) -> _DigitStream:
    stream = _DigitStream(config["recentWindow"], config["longWindow"])
    for value in history_digits:
        stream.append(value)
    return stream


def _rank_from_stream(stream: _DigitStream, config: dict) -> list[dict]:
    history_length = len(stream.values)
    if history_length == 0:
        return [
            {
                "digit": digit,
                "score": 0.0,
                "totalCount": 0,
                "recentCount": 0,
                "missSpan": 0,
                "transitionCount": 0,
                "pairTransitionCount": 0,
                "breakdown": {"recent": 0.0, "long": 0.0, "omission": 0.0, "transition": 0.0, "pairTransition": 0.0},
            }
            for digit in DIGITS
        ]

    recent_window = min(config["recentWindow"], history_length)
    long_window = min(config["longWindow"], history_length)
    recent_counts = stream.recent_counts
    long_counts = stream.long_counts
    last_digit = stream.values[-1]
    prev_digit = stream.values[-2] if history_length >= 2 else None
    transition_counts = stream.transition_counts([last_digit])
    pair_transition_counts = (
        [0] * 10 if prev_digit is None else stream.transition_counts([prev_digit, last_digit])
    )
    transition_total = sum_counts(transition_counts)
    pair_transition_total = sum_counts(pair_transition_counts)
    omission_cap = max(6, math.ceil(long_window / 3))
    weights = config["scoreWeights"]

    scored = []
    for digit in DIGITS:
        recent_score = recent_counts[digit] / max(recent_window, 1)
        long_score = long_counts[digit] / max(long_window, 1)
        miss_span = stream.miss_span(digit)
        omission_score = min(miss_span / omission_cap, 1)
        transition_score = transition_counts[digit] / transition_total if transition_total > 0 else 0.0
        pair_transition_score = (
            pair_transition_counts[digit] / pair_transition_total if pair_transition_total > 0 else 0.0
        )
        breakdown = {
            "recent": round_score(recent_score * weights["recent"] * 100),
            "long": round_score(long_score * weights["long"] * 100),
            "omission": round_score(omission_score * weights["omission"] * 100),
            "transition": round_score(transition_score * weights["transition"] * 100),
            "pairTransition": round_score(pair_transition_score * weights["pairTransition"] * 100),
        }
        score = (
            breakdown["recent"]
            + breakdown["long"]
            + breakdown["omission"]
            + breakdown["transition"]
            + breakdown["pairTransition"]
        )
        scored.append(
            {
                "digit": digit,
                "score": round_score(score),
                "totalCount": long_counts[digit],
                "recentCount": recent_counts[digit],
                "missSpan": miss_span,
                "transitionCount": transition_counts[digit],
                "pairTransitionCount": pair_transition_counts[digit],
                "breakdown": breakdown,
            }
        )

    scored.sort(
        key=lambda item: (
            -item["score"],
            -item["recentCount"],
            -item["totalCount"],
            -item["missSpan"],
            item["digit"],
        )
    )
    return scored


def _markov_from_stream(stream: _DigitStream, order: int, candidate_count: int) -> dict:
    history_length = len(stream.values)
    if history_length == 0:
        return {
            "effectiveOrder": 0,
            "sourcePattern": [],
            "supportCount": 0,
            "rankedDigits": [
                {"digit": digit, "probability": 0.0, "count": 0} for digit in DIGITS
            ][: max(candidate_count, len(DIGITS))],
        }

    capped_order = max(1, min(order, history_length - 1))
    for current_order in range(capped_order, 0, -1):
        source_pattern = stream.values[-current_order:]
        counts = stream.transition_counts(source_pattern)
        support_count = sum_counts(counts)
        if support_count > 0:
            return {
                "effectiveOrder": current_order,
                "sourcePattern": source_pattern,
                "supportCount": support_count,
                "rankedDigits": build_markov_candidates(counts, support_count),
            }

    return {
        "effectiveOrder": 0,
        "sourcePattern": [],
        "supportCount": history_length,
        "rankedDigits": build_markov_candidates(stream.total, history_length),
    }


def build_markov_candidates(counts: list[int], support_count: int) -> list[dict]:
    candidates = [
        {
            "digit": digit,
            "probability": (counts[digit] / support_count) if support_count > 0 else 0.0,
            "count": counts[digit],
        }
        for digit in DIGITS
    ]
    candidates.sort(key=lambda item: (-item["probability"], -item["count"], item["digit"]))
    return candidates


def build_markov_snapshot(history_digits: list[int], order: int, candidate_count: int) -> dict:
    stream = _DigitStream(RECENT_WINDOW, LONG_WINDOW)
    for value in history_digits:
        stream.append(value)
    return _markov_from_stream(stream, order, candidate_count)


def rank_next_digits(history_digits: list[int], config: dict) -> list[dict]:
    stream = _DigitStream(config["recentWindow"], config["longWindow"])
    for value in history_digits:
        stream.append(value)
    return _rank_from_stream(stream, config)


def run_backtest(history_digits: list[int], config: dict) -> dict:
    min_training_size = min(config["minTrainingSize"], max(10, len(history_digits) - 1))
    if len(history_digits) <= min_training_size:
        return {"samples": 0, "top1Hits": 0, "top3Hits": 0, "top1Rate": 0.0, "top3Rate": 0.0}

    stream = _DigitStream(config["recentWindow"], config["longWindow"])
    for value in history_digits[:min_training_size]:
        stream.append(value)

    samples = top1_hits = top3_hits = 0
    for index in range(min_training_size, len(history_digits)):
        ranked = _rank_from_stream(stream, config)
        actual = history_digits[index]
        top3 = [item["digit"] for item in ranked[:3]]
        samples += 1
        if ranked[0]["digit"] == actual:
            top1_hits += 1
        if actual in top3:
            top3_hits += 1
        stream.append(actual)

    return {
        "samples": samples,
        "top1Hits": top1_hits,
        "top3Hits": top3_hits,
        "top1Rate": top1_hits / samples if samples > 0 else 0.0,
        "top3Rate": top3_hits / samples if samples > 0 else 0.0,
    }


def run_markov_backtest(history_digits: list[int], config: dict) -> dict:
    minimum_required = max(config["markovOrder"] + 2, 10)
    min_training_size = min(config["minTrainingSize"], max(minimum_required, len(history_digits) - 1))
    if len(history_digits) <= min_training_size:
        return {"samples": 0, "top1Hits": 0, "top3Hits": 0, "top1Rate": 0.0, "top3Rate": 0.0}

    stream = _DigitStream(config["recentWindow"], config["longWindow"])
    for value in history_digits[:min_training_size]:
        stream.append(value)

    samples = top1_hits = top3_hits = 0
    for index in range(min_training_size, len(history_digits)):
        snapshot = _markov_from_stream(stream, config["markovOrder"], config["combinationPoolSize"])
        actual = history_digits[index]
        ranked = snapshot["rankedDigits"]
        top3 = [item["digit"] for item in ranked[:3]]
        samples += 1
        if ranked[0]["digit"] == actual:
            top1_hits += 1
        if actual in top3:
            top3_hits += 1
        stream.append(actual)

    return {
        "samples": samples,
        "top1Hits": top1_hits,
        "top3Hits": top3_hits,
        "top1Rate": top1_hits / samples if samples > 0 else 0.0,
        "top3Rate": top3_hits / samples if samples > 0 else 0.0,
    }


def _beam_combinations(positions: list[dict], config: dict, *, markov: bool) -> list[dict]:
    key = "markov" if markov else None
    pools = []
    for position in positions:
        candidates = position[key]["candidates"] if markov else position["candidates"]
        pools.append(candidates[: config["combinationPoolSize"]])
    if any(len(pool) == 0 for pool in pools):
        return []

    beams = [{"value": "", "score": 0.0}]
    for pool in pools:
        next_beams = []
        for beam in beams:
            for candidate in pool:
                score = round_score(beam["score"] + (candidate["probability"] * 100 if markov else candidate["score"]))
                next_beams.append({"value": f"{beam['value']}{candidate['digit']}", "score": score})
        next_beams.sort(key=lambda item: (-item["score"], item["value"]))
        beams = next_beams[: max(config["combinationLimit"] * 2, config["combinationLimit"])]

    return beams[: config["combinationLimit"]]


def build_combination_candidates(positions: list[dict], config: dict) -> list[dict]:
    return _beam_combinations(positions, config, markov=False)


def build_markov_combination_candidates(positions: list[dict], config: dict) -> list[dict]:
    return _beam_combinations(positions, config, markov=True)


def _get_draw_sum(draw: list[int]) -> int:
    return sum(draw)


def _get_draw_span(draw: list[int]) -> int:
    return 0 if not draw else max(draw) - min(draw)


def build_hot_cold_stats(valid_draws: list[list[int]], config: dict) -> dict:
    recent_draws = valid_draws[-config["recentWindow"] :] if config["recentWindow"] else []
    long_draws = valid_draws[-config["longWindow"] :] if config["longWindow"] else []
    recent_counts = count_digits([digit for draw in recent_draws for digit in draw])
    long_counts = count_digits([digit for draw in long_draws for digit in draw])
    digit_stats = [
        {
            "digit": digit,
            "recentCount": recent_counts[digit],
            "longCount": long_counts[digit],
            "missSpan": get_draw_miss_span(valid_draws, digit),
        }
        for digit in DIGITS
    ]
    hot = sorted(
        digit_stats,
        key=lambda item: (-item["recentCount"], -item["longCount"], item["missSpan"], item["digit"]),
    )[:5]
    cold = sorted(
        digit_stats,
        key=lambda item: (item["recentCount"], item["longCount"], -item["missSpan"], item["digit"]),
    )[:5]
    return {
        "recentWindow": config["recentWindow"],
        "longWindow": config["longWindow"],
        "hotDigits": hot,
        "coldDigits": cold,
    }


def build_sum_span_stats(valid_draws: list[list[int]], config: dict) -> dict:
    recent_draws = valid_draws[-config["recentWindow"] :] if config["recentWindow"] else []
    long_draws = valid_draws[-config["longWindow"] :] if config["longWindow"] else []
    sum_counts: dict[str, int] = {}
    span_counts: dict[str, int] = {}
    for draw in long_draws:
        _increment(sum_counts, str(_get_draw_sum(draw)))
        _increment(span_counts, str(_get_draw_span(draw)))
    return {
        "recentAverageSum": _average_number([_get_draw_sum(draw) for draw in recent_draws]),
        "recentAverageSpan": _average_number([_get_draw_span(draw) for draw in recent_draws]),
        "topSums": _build_top_buckets(sum_counts, len(long_draws), 5),
        "topSpans": _build_top_buckets(span_counts, len(long_draws), 5),
    }


def build_parity_size_stats(valid_draws: list[list[int]], config: dict) -> dict:
    recent_draws = valid_draws[-config["recentWindow"] :] if config["recentWindow"] else []
    recent_digits = [digit for draw in recent_draws for digit in draw]
    odd_count = sum(1 for digit in recent_digits if digit % 2 != 0)
    even_count = len(recent_digits) - odd_count
    big_count = sum(1 for digit in recent_digits if digit >= 5)
    small_count = len(recent_digits) - big_count
    odd_even_patterns: dict[str, int] = {}
    big_small_patterns: dict[str, int] = {}
    for draw in recent_draws:
        odd_in_draw = sum(1 for digit in draw if digit % 2 != 0)
        big_in_draw = sum(1 for digit in draw if digit >= 5)
        _increment(odd_even_patterns, f"{odd_in_draw}:{len(draw) - odd_in_draw}")
        _increment(big_small_patterns, f"{big_in_draw}:{len(draw) - big_in_draw}")
    return {
        "oddRate": _safe_rate(odd_count, len(recent_digits)),
        "evenRate": _safe_rate(even_count, len(recent_digits)),
        "bigRate": _safe_rate(big_count, len(recent_digits)),
        "smallRate": _safe_rate(small_count, len(recent_digits)),
        "oddEvenPatterns": _build_top_buckets(odd_even_patterns, len(recent_draws), 3),
        "bigSmallPatterns": _build_top_buckets(big_small_patterns, len(recent_draws), 3),
    }


def build_prediction_statistics(valid_draws: list[list[int]], config: dict) -> dict:
    return {
        "hotCold": build_hot_cold_stats(valid_draws, config),
        "sumSpan": build_sum_span_stats(valid_draws, config),
        "paritySize": build_parity_size_stats(valid_draws, config),
    }


def resolve_prediction_config(options: dict | None = None) -> dict:
    options = options or {}
    weights = dict(DEFAULT_PREDICTION_SCORE_WEIGHTS)
    weights.update(options.get("scoreWeights") or {})
    return {
        "recentWindow": _to_bounded_integer(options.get("recentWindow"), RECENT_WINDOW, 5, 60),
        "longWindow": _to_bounded_integer(options.get("longWindow"), LONG_WINDOW, 20, 180),
        "minTrainingSize": _to_bounded_integer(options.get("minTrainingSize"), MIN_TRAINING_SIZE, 10, 120),
        "combinationPoolSize": _to_bounded_integer(options.get("combinationPoolSize"), COMBINATION_POOL_SIZE, 1, 5),
        "combinationLimit": _to_bounded_integer(options.get("combinationLimit"), COMBINATION_LIMIT, 1, 20),
        "markovOrder": _to_bounded_integer(options.get("markovOrder"), DEFAULT_MARKOV_ORDER, 1, 5),
        "scoreWeights": _normalize_score_weights(weights),
    }


def resolve_math_trend_config(options: dict | None = None) -> dict:
    options = options or {}
    return {
        "sampleWindow": _to_bounded_integer(options.get("sampleWindow"), MATH_SAMPLE_WINDOW, 80, 400),
        "trendWindow": _to_bounded_integer(options.get("trendWindow"), MATH_TREND_WINDOW, 12, 90),
        "validationStart": _to_bounded_integer(options.get("validationStart"), MATH_VALIDATION_START, 40, 240),
        "candidateCount": _to_bounded_integer(options.get("candidateCount"), MATH_CANDIDATE_COUNT, 1, 5),
    }


def get_valid_draws(entries: list[dict]) -> list[list[int]]:
    draws = []
    for entry in entries:
        parsed = [parse_digit_value(value) for value in entry.get("numbers", [])]
        digits = [value for value in parsed if value is not None]
        if len(digits) == POSITION_COUNT:
            draws.append(digits)
    return draws


def _position_digits(entries: list[dict], position: int) -> list[int]:
    values = []
    for entry in entries:
        numbers = entry.get("numbers", [])
        raw = numbers[position] if position < len(numbers) else None
        digit = parse_digit_value(raw)
        if digit is not None:
            values.append(digit)
    return values


def analyze_position(entries: list[dict], position: int, config: dict) -> dict:
    digits = _position_digits(entries, position)
    ranked = rank_next_digits(digits, config)
    markov = build_markov_snapshot(digits, config["markovOrder"], config["combinationPoolSize"])
    return {
        "position": position,
        "picks": [item["digit"] for item in ranked[: config["combinationPoolSize"]]],
        "candidates": ranked[:5],
        "latestDigit": digits[-1] if digits else None,
        "historySample": len(digits),
        "recentDigits": list(reversed(digits[-config["recentWindow"] :])),
        "backtest": run_backtest(digits, config),
        "markov": {
            "order": config["markovOrder"],
            "effectiveOrder": markov["effectiveOrder"],
            "sourcePattern": markov["sourcePattern"],
            "supportCount": markov["supportCount"],
            "picks": [item["digit"] for item in markov["rankedDigits"][: config["combinationPoolSize"]]],
            "candidates": markov["rankedDigits"][:5],
            "backtest": run_markov_backtest(digits, config),
        },
    }


def analyze_history_prediction(entries: list[dict], options: dict | None = None) -> dict:
    config = resolve_prediction_config(options)
    sorted_entries = sort_chronological(entries)
    valid_draws = get_valid_draws(sorted_entries)
    position_count = max(1, math.floor((options or {}).get("positionCount") or POSITION_COUNT))
    positions = [analyze_position(sorted_entries, position, config) for position in range(position_count)]

    return {
        "sampleSize": len(sorted_entries),
        "averageTop1Rate": _average_rate([item["backtest"]["top1Rate"] for item in positions]),
        "averageTop3Rate": _average_rate([item["backtest"]["top3Rate"] for item in positions]),
        "positions": positions,
        "combinations": build_combination_candidates(positions, config),
        "markov": {
            "order": config["markovOrder"],
            "averageTop1Rate": _average_rate([item["markov"]["backtest"]["top1Rate"] for item in positions]),
            "averageTop3Rate": _average_rate([item["markov"]["backtest"]["top3Rate"] for item in positions]),
            "combinations": build_markov_combination_candidates(positions, config),
        },
        "config": config,
        "statistics": build_prediction_statistics(valid_draws, config),
    }


# ── 数学走势（math_trend）────────────────────────────────────────────────────

def _get_math_training_digits(history_digits: list[int], config: dict) -> list[int]:
    return history_digits[-min(config["sampleWindow"], len(history_digits)) :]


def compute_linear_slope(values: list[float]) -> float:
    if len(values) <= 1:
        return 0.0
    mean_x = (len(values) - 1) / 2
    mean_y = _average_number(values)
    numerator = 0.0
    denominator = 0.0
    for index, value in enumerate(values):
        delta_x = index - mean_x
        numerator += delta_x * (value - mean_y)
        denominator += delta_x * delta_x
    return 0.0 if denominator <= 0 else numerator / denominator


def compute_standard_deviation(values: list[float], mean: float | None = None) -> float:
    if not values:
        return 0.0
    average = _average_number(values) if mean is None else mean
    variance = sum((value - average) ** 2 for value in values) / len(values)
    return math.sqrt(max(variance, 0))


def compute_forecast_center(values: list[float]) -> float | None:
    if not values:
        return None
    slope = compute_linear_slope(values)
    average = _average_number(values)
    weighted_average = sum(value * (index + 1) for index, value in enumerate(values)) / (
        (len(values) * (len(values) + 1)) / 2
    )
    forecast = weighted_average + slope + (weighted_average - average) * 0.4
    return round_score(_clamp_number(forecast, 0, 9))


def get_average_gap(values: list[int], digit: int, fallback: float) -> float:
    occurrence_indexes = [index for index, value in enumerate(values) if value == digit]
    if len(occurrence_indexes) <= 1:
        return fallback
    gaps = [
        occurrence_indexes[index] - occurrence_indexes[index - 1]
        for index in range(1, len(occurrence_indexes))
    ]
    return _average_number(gaps)


def build_math_trend_snapshot(history_digits: list[int], config: dict) -> dict:
    training_digits = _get_math_training_digits(history_digits, config)
    if not training_digits:
        return {
            "trainingDigits": training_digits,
            "predictedCenter": None,
            "trendSlope": 0.0,
            "recentAverage": 0.0,
            "volatility": 0.0,
            "rankedDigits": [
                {
                    "digit": digit,
                    "score": 0.0,
                    "occurrenceRate": 0.0,
                    "recentMomentum": 0.0,
                    "averageGap": 0.0,
                    "currentGap": 0,
                    "predictedDistance": 0.0,
                    "distributionGap": 0.0,
                    "breakdown": {"distribution": 0.0, "trend": 0.0, "cycle": 0.0, "momentum": 0.0},
                }
                for digit in DIGITS
            ],
        }

    trend_digits = training_digits[-min(config["trendWindow"], len(training_digits)) :]
    previous_start = max(len(training_digits) - len(trend_digits) * 2, 0)
    previous_end = max(len(training_digits) - len(trend_digits), 0)
    previous_trend_digits = training_digits[previous_start:previous_end]

    predicted_center = compute_forecast_center(trend_digits)
    trend_slope = compute_linear_slope(trend_digits)
    recent_average = _average_number(trend_digits)
    volatility = compute_standard_deviation(trend_digits, recent_average)

    long_counts = count_digits(training_digits)
    recent_counts = count_digits(trend_digits)
    previous_counts = count_digits(previous_trend_digits)
    expected_count = len(training_digits) / len(DIGITS)
    sigma = max(volatility, 1.4)
    fallback_average_gap = max(len(training_digits) / len(DIGITS), 1)

    ranked_digits = []
    for digit in DIGITS:
        occurrence_rate = _safe_rate(long_counts[digit], len(training_digits))
        distribution_gap = round_score(expected_count - long_counts[digit])
        distribution_score = _clamp_zero_to_one(
            0.5 + (expected_count - long_counts[digit]) / max(expected_count * 2, 1)
        )
        predicted_distance = 0.0 if predicted_center is None else abs(digit - predicted_center)
        trend_score = (
            0.0
            if predicted_center is None
            else math.exp(-((predicted_distance * predicted_distance) / (2 * sigma * sigma)))
        )
        average_gap = get_average_gap(training_digits, digit, fallback_average_gap)
        current_gap = get_miss_span(training_digits, digit)
        cycle_ratio = current_gap / max(average_gap, 1)
        cycle_score = max(0.0, 1 - min(abs(cycle_ratio - 1), 1))
        recent_rate = _safe_rate(recent_counts[digit], len(trend_digits))
        previous_rate = (
            _safe_rate(previous_counts[digit], len(previous_trend_digits))
            if previous_trend_digits
            else occurrence_rate
        )
        recent_momentum = recent_rate - previous_rate
        momentum_score = _clamp_zero_to_one(0.5 + recent_momentum * 2.5)

        breakdown = {
            "distribution": round_score(distribution_score * 26),
            "trend": round_score(trend_score * 38),
            "cycle": round_score(cycle_score * 20),
            "momentum": round_score(momentum_score * 16),
        }
        ranked_digits.append(
            {
                "digit": digit,
                "score": round_score(
                    breakdown["distribution"] + breakdown["trend"] + breakdown["cycle"] + breakdown["momentum"]
                ),
                "occurrenceRate": occurrence_rate,
                "recentMomentum": round_score(recent_momentum * 100),
                "averageGap": round_score(average_gap),
                "currentGap": current_gap,
                "predictedDistance": round_score(predicted_distance),
                "distributionGap": distribution_gap,
                "breakdown": breakdown,
            }
        )

    ranked_digits.sort(
        key=lambda item: (
            -item["score"],
            item["predictedDistance"],
            -item["distributionGap"],
            -item["currentGap"],
            item["digit"],
        )
    )

    return {
        "trainingDigits": training_digits,
        "predictedCenter": predicted_center,
        "trendSlope": round_score(trend_slope),
        "recentAverage": round_score(recent_average),
        "volatility": round_score(volatility),
        "rankedDigits": ranked_digits,
    }


def run_math_trend_backtest(history_digits: list[int], config: dict) -> dict:
    min_training_size = min(config["validationStart"], max(40, len(history_digits) - 1))
    if len(history_digits) <= min_training_size:
        return {"samples": 0, "top1Hits": 0, "top3Hits": 0, "top1Rate": 0.0, "top3Rate": 0.0}

    samples = top1_hits = top3_hits = 0
    for index in range(min_training_size, len(history_digits)):
        ranked = build_math_trend_snapshot(history_digits[:index], config)["rankedDigits"]
        actual = history_digits[index]
        top3 = [item["digit"] for item in ranked[:3]]
        samples += 1
        if ranked and ranked[0]["digit"] == actual:
            top1_hits += 1
        if actual in top3:
            top3_hits += 1
    return {
        "samples": samples,
        "top1Hits": top1_hits,
        "top3Hits": top3_hits,
        "top1Rate": top1_hits / samples if samples > 0 else 0.0,
        "top3Rate": top3_hits / samples if samples > 0 else 0.0,
    }


def analyze_math_trend_position(entries: list[dict], position: int, config: dict) -> dict:
    digits = _position_digits(entries, position)
    snapshot = build_math_trend_snapshot(digits, config)
    return {
        "position": position,
        "picks": [item["digit"] for item in snapshot["rankedDigits"][: config["candidateCount"]]],
        "candidates": snapshot["rankedDigits"][:5],
        "latestDigit": digits[-1] if digits else None,
        "historySample": len(digits),
        "sampleWindow": len(snapshot["trainingDigits"]),
        "recentDigits": list(reversed(snapshot["trainingDigits"][-MATH_RECENT_DIGIT_COUNT:])),
        "backtest": run_math_trend_backtest(digits, config),
        "predictedCenter": snapshot["predictedCenter"],
        "trendSlope": snapshot["trendSlope"],
        "recentAverage": snapshot["recentAverage"],
        "volatility": snapshot["volatility"],
    }


def analyze_math_trend_prediction(entries: list[dict], options: dict | None = None) -> dict:
    config = resolve_math_trend_config(options)
    sorted_entries = sort_chronological(entries)
    positions = [
        analyze_math_trend_position(sorted_entries, position, config) for position in range(POSITION_COUNT)
    ]
    sample_size = len(sorted_entries)
    return {
        "sampleSize": sample_size,
        "effectiveSampleWindow": min(config["sampleWindow"], sample_size),
        "validationStart": config["validationStart"],
        "averageTop1Rate": _average_rate([item["backtest"]["top1Rate"] for item in positions]),
        "averageTop3Rate": _average_rate([item["backtest"]["top3Rate"] for item in positions]),
        "positions": positions,
        "config": config,
    }
