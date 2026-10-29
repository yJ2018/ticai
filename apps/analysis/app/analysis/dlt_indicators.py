"""大乐透前区 / 后区逐期指标（对齐 apps/api/src/analysis/dlt-indicators.mjs）。

口径：
- 和值：前区 5 个号码之和（15–165）；后区 2 个号码之和（3–23）
- 跨度：最大号 − 最小号（前区 4–34，后区 1–11）
- 奇偶比：奇数个数 : 偶数个数
- 大小比：大号（18–35） : 小号（1–17）
- 三区比：一区 1–12 : 二区 13–24 : 三区 25–35
"""

from __future__ import annotations

from typing import Any

DLT_FRONT_BALL_COUNT = 5
DLT_FRONT_MIN = 1
DLT_FRONT_MAX = 35
DLT_BACK_BALL_COUNT = 2
DLT_BACK_MIN = 1
DLT_BACK_MAX = 12

# 前区大小分界：18–35 为大号，1–17 为小号
DLT_BIG_NUMBER_MIN = 18

# 三区上界：1–12 / 13–24 / 25–35
ZONE_UPPER_LIMITS = (12, 24, 35)


def get_dlt_front_zone_index(value: int) -> int:
    if value <= ZONE_UPPER_LIMITS[0]:
        return 0
    if value <= ZONE_UPPER_LIMITS[1]:
        return 1
    return 2


def _to_int(value: Any) -> int | None:
    """对齐 JS `Number(value)` + `Number.isInteger`：只接受可转成整数的值。"""
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not numeric.is_integer():
        return None
    return int(numeric)


def parse_dlt_front_numbers(numbers: list[Any]) -> list[int] | None:
    if len(numbers) < DLT_FRONT_BALL_COUNT:
        return None
    parsed = []
    for index in range(DLT_FRONT_BALL_COUNT):
        value = _to_int(numbers[index])
        if value is None or value < DLT_FRONT_MIN or value > DLT_FRONT_MAX:
            return None
        parsed.append(value)
    return parsed


def parse_dlt_back_numbers(numbers: list[Any]) -> list[int] | None:
    if len(numbers) < DLT_FRONT_BALL_COUNT + DLT_BACK_BALL_COUNT:
        return None
    parsed = []
    for index in range(DLT_BACK_BALL_COUNT):
        value = _to_int(numbers[DLT_FRONT_BALL_COUNT + index])
        if value is None or value < DLT_BACK_MIN or value > DLT_BACK_MAX:
            return None
        parsed.append(value)
    return parsed


def compute_dlt_front_indicators(front_numbers: list[int]) -> dict | None:
    if len(front_numbers) < DLT_FRONT_BALL_COUNT:
        return None
    numbers = front_numbers[:DLT_FRONT_BALL_COUNT]
    for value in numbers:
        if not isinstance(value, int) or value < DLT_FRONT_MIN or value > DLT_FRONT_MAX:
            return None

    total = 0
    odd = 0
    big = 0
    zones = [0, 0, 0]
    minimum = numbers[0]
    maximum = numbers[0]
    for value in numbers:
        total += value
        if value % 2 == 1:
            odd += 1
        if value >= DLT_BIG_NUMBER_MIN:
            big += 1
        if value < minimum:
            minimum = value
        if value > maximum:
            maximum = value
        zones[get_dlt_front_zone_index(value)] += 1

    return {
        "sum": total,
        "span": maximum - minimum,
        "odd": odd,
        "even": DLT_FRONT_BALL_COUNT - odd,
        "big": big,
        "small": DLT_FRONT_BALL_COUNT - big,
        "zones": zones,
    }


def compute_dlt_back_indicators(back_numbers: list[int]) -> dict | None:
    if len(back_numbers) < DLT_BACK_BALL_COUNT:
        return None
    numbers = back_numbers[:DLT_BACK_BALL_COUNT]
    for value in numbers:
        if not isinstance(value, int) or value < DLT_BACK_MIN or value > DLT_BACK_MAX:
            return None

    total = 0
    odd = 0
    minimum = numbers[0]
    maximum = numbers[0]
    for value in numbers:
        total += value
        if value % 2 == 1:
            odd += 1
        if value < minimum:
            minimum = value
        if value > maximum:
            maximum = value

    return {
        "sum": total,
        "span": maximum - minimum,
        "odd": odd,
        "even": DLT_BACK_BALL_COUNT - odd,
    }


def get_dlt_front_indicators(numbers: list[Any]) -> dict | None:
    parsed = parse_dlt_front_numbers(numbers)
    return compute_dlt_front_indicators(parsed) if parsed else None


def get_dlt_back_indicators(numbers: list[Any]) -> dict | None:
    parsed = parse_dlt_back_numbers(numbers)
    return compute_dlt_back_indicators(parsed) if parsed else None


def summarize_dlt_front_indicators(items: list[dict | None]) -> dict | None:
    valid = [item for item in items if item is not None]
    if not valid:
        return None
    total = span = odd = big = zone0 = zone1 = zone2 = 0
    for item in valid:
        total += item["sum"]
        span += item["span"]
        odd += item["odd"]
        big += item["big"]
        zone0 += item["zones"][0]
        zone1 += item["zones"][1]
        zone2 += item["zones"][2]
    size = len(valid)
    return {
        "sampleSize": size,
        "averageSum": total / size,
        "averageSpan": span / size,
        "averageOdd": odd / size,
        "averageBig": big / size,
        "averageZones": [zone0 / size, zone1 / size, zone2 / size],
    }


def format_dlt_odd_even(indicators: dict) -> str:
    return f"{indicators['odd']}:{indicators['even']}"


def format_dlt_big_small(indicators: dict) -> str:
    return f"{indicators['big']}:{indicators['small']}"


def format_dlt_zones(indicators: dict) -> str:
    return ":".join(str(value) for value in indicators["zones"])


def format_dlt_average(value: float) -> str:
    return f"{value:.1f}" if isinstance(value, (int, float)) else "--"
