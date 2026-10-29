"""分析快照的配置指纹与预设组合（对齐 apps/api/src/analysis/configs.mjs）。"""

from __future__ import annotations

import math
import re

from .prediction import DEFAULT_PREDICTION_SCORE_WEIGHTS

ENGINE_VERSION = "snapshot-1"
KINDS = ("prediction", "math_trend", "dlt")
PREDICTION_MARKOV_ORDERS = (1, 2, 3, 4, 5)
PREDICTION_DEFAULT_ORDER = 2

MATH_TREND_DEFAULTS = {
    "sampleWindow": 240,
    "trendWindow": 36,
    "validationStart": 120,
    "candidateCount": 3,
}

DLT_WINDOW = 300

_WEIGHT_KEYS = ("recent", "long", "omission", "transition", "pairTransition")


def default_kind_for_game(game: dict) -> str:
    return "prediction" if game.get("is_positional") else "dlt"


def _clamp_int(value, fallback: int, minimum: int, maximum: int) -> int:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(numeric):
        return fallback
    return min(max(math.floor(numeric), minimum), maximum)


def _js_number(value: float) -> str:
    """模仿 JS 的 Number → 字符串：34.0 → "34"，39.5 → "39.5"。"""
    return str(int(value)) if float(value).is_integer() else str(value)


def _weights_percent(weights: dict) -> list[float]:
    return [_js_round2(float(weights.get(key, 0) or 0) * 100) for key in _WEIGHT_KEYS]


def _js_round2(value: float) -> float:
    # JS toFixed(2) 再 Number：保留两位，末尾 .0 去掉由 _js_number 处理
    return round(value + 1e-9, 2)


def _is_default_weights(weights: dict) -> bool:
    current = _weights_percent(weights)
    base = _weights_percent(DEFAULT_PREDICTION_SCORE_WEIGHTS)
    return current == base


def prediction_config_key(options: dict | None = None) -> str:
    options = options or {}
    order = _clamp_int(options.get("markovOrder"), PREDICTION_DEFAULT_ORDER, 1, 5)
    weights = dict(DEFAULT_PREDICTION_SCORE_WEIGHTS)
    weights.update(options.get("scoreWeights") or {})
    base = f"markov={order}"
    if _is_default_weights(weights):
        return base
    return f"{base};w={'-'.join(_js_number(value) for value in _weights_percent(weights))}"


def parse_prediction_config_key(config_key: str) -> dict:
    text = str(config_key)
    order_match = re.search(r"markov=(\d+)", text)
    weights_match = re.search(r"w=([\d.\-]+)", text)
    options = {"markovOrder": _clamp_int(order_match.group(1) if order_match else None, PREDICTION_DEFAULT_ORDER, 1, 5)}
    if weights_match:
        parts = weights_match.group(1).split("-")
        try:
            values = [float(part) for part in parts]
        except ValueError:
            values = []
        if len(values) == 5 and all(math.isfinite(value) for value in values):
            options["scoreWeights"] = {
                "recent": values[0] / 100,
                "long": values[1] / 100,
                "omission": values[2] / 100,
                "transition": values[3] / 100,
                "pairTransition": values[4] / 100,
            }
    return options


def math_trend_config_key(options: dict | None = None) -> str:
    options = options or {}
    window = _clamp_int(options.get("sampleWindow"), MATH_TREND_DEFAULTS["sampleWindow"], 80, 400)
    trend = _clamp_int(options.get("trendWindow"), MATH_TREND_DEFAULTS["trendWindow"], 12, 90)
    validate = _clamp_int(options.get("validationStart"), MATH_TREND_DEFAULTS["validationStart"], 40, 240)
    candidates = _clamp_int(options.get("candidateCount"), MATH_TREND_DEFAULTS["candidateCount"], 1, 5)
    return f"window={window};trend={trend};validate={validate};candidates={candidates}"


def parse_math_trend_config_key(config_key: str) -> dict:
    text = str(config_key)

    def read(name: str, fallback: int) -> int:
        hit = re.search(rf"{name}=(\d+)", text)
        return int(hit.group(1)) if hit else fallback

    return {
        "sampleWindow": read("window", MATH_TREND_DEFAULTS["sampleWindow"]),
        "trendWindow": read("trend", MATH_TREND_DEFAULTS["trendWindow"]),
        "validationStart": read("validate", MATH_TREND_DEFAULTS["validationStart"]),
        "candidateCount": read("candidates", MATH_TREND_DEFAULTS["candidateCount"]),
    }


def dlt_config_key() -> str:
    return f"window={DLT_WINDOW}"


def analysis_options(kind: str, game: dict, config_key: str) -> dict:
    if kind == "prediction":
        return {**parse_prediction_config_key(config_key), "positionCount": game.get("main_count") or 5}
    if kind == "math_trend":
        return parse_math_trend_config_key(config_key)
    return {}


def presets_for_game(game: dict) -> list[dict]:
    if game.get("game_key") == "dlt" or not game.get("is_positional"):
        return [{"kind": "dlt", "configKey": dlt_config_key(), "options": {}}] if game.get("game_key") == "dlt" else []

    presets = [
        {"kind": "prediction", "configKey": prediction_config_key({"markovOrder": order}), "options": {"markovOrder": order}}
        for order in PREDICTION_MARKOV_ORDERS
    ]
    presets.append({"kind": "math_trend", "configKey": math_trend_config_key(), "options": {}})
    return presets
