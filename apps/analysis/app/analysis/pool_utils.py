"""号码池型彩种的公共统计工具（对齐 apps/api/src/analysis/pool-utils.mjs）。"""

from __future__ import annotations

import math

POOL_WINDOWS = {"short": 10, "recent": 30, "long": 100}


def rank_pool_numbers(
    series: list[list[int]],
    *,
    minimum: int,
    maximum: int,
    pick_per_draw: int,
    windows: dict,
    repeat_set: set[int] | None = None,
    neighbor_set: set[int] | None = None,
) -> list[dict]:
    domain_size = maximum - minimum + 1
    counts = [
        {"short": 0, "recent": 0, "long": 0, "miss": None, "repeat": 0, "neighbor": 0}
        for _ in range(domain_size)
    ]

    for index, numbers in enumerate(series):
        for number in numbers:
            offset = number - minimum
            if offset < 0 or offset >= domain_size:
                continue
            count = counts[offset]
            if index < windows["long"]:
                count["long"] += 1
            if index < windows["short"]:
                count["short"] += 1
            if index < windows["recent"]:
                count["recent"] += 1
            if count["miss"] is None:
                count["miss"] = index
            if index == 0:
                if repeat_set and number in repeat_set:
                    count["repeat"] = 1
                if neighbor_set and number in neighbor_set:
                    count["neighbor"] = 1

    expected_short = max((windows["short"] * pick_per_draw) / domain_size, 1e-6)
    expected_recent = max((windows["recent"] * pick_per_draw) / domain_size, 1e-6)
    expected_long = max((windows["long"] * pick_per_draw) / domain_size, 1e-6)
    expected_gap = domain_size / pick_per_draw

    ranked = []
    for offset, count in enumerate(counts):
        number = minimum + offset
        miss_span = count["miss"] if count["miss"] is not None else windows["long"]
        score = (
            0.3 * (count["short"] / expected_short)
            + 0.25 * (count["recent"] / expected_recent)
            + 0.2 * (count["long"] / expected_long)
            + 0.25 * min(miss_span / expected_gap, 3)
        )
        score += 0.06 * count["repeat"] + 0.04 * count["neighbor"]
        ranked.append(
            {
                "number": number,
                "score": score,
                "shortCount": count["short"],
                "recentCount": count["recent"],
                "longCount": count["long"],
                "missSpan": miss_span,
                "repeat": count["repeat"],
                "neighbor": count["neighbor"],
            }
        )

    ranked.sort(key=lambda item: (-item["score"], -item["missSpan"], item["number"]))
    return ranked


def zone_index_of(number: int, zone_limits: list[int]) -> int:
    for index, upper in enumerate(zone_limits):
        if number <= upper:
            return index
    return len(zone_limits) - 1


def pick_zone_pool(ranked: list[dict], *, zone_limits: list[int], per_zone: int) -> list[int]:
    by_zone: list[list[dict]] = [[] for _ in zone_limits]
    for stat in ranked:
        by_zone[zone_index_of(stat["number"], zone_limits)].append(stat)

    picked: list[int] = []
    for stats in by_zone:
        picked.extend(stat["number"] for stat in stats[:per_zone])
    picked.sort()
    return picked


def compute_number_indicators(numbers: list[int], *, big_min: int, zone_limits: list[int]) -> dict | None:
    if not numbers:
        return None

    sorted_numbers = sorted(numbers)
    total = 0
    odd = 0
    big = 0
    minimum = sorted_numbers[0]
    maximum = sorted_numbers[0]
    zones = [0 for _ in zone_limits]

    for value in sorted_numbers:
        total += value
        if value % 2 == 1:
            odd += 1
        if value >= big_min:
            big += 1
        if value < minimum:
            minimum = value
        if value > maximum:
            maximum = value
        zones[zone_index_of(value, zone_limits)] += 1

    consecutive = 0
    for index in range(1, len(sorted_numbers)):
        if sorted_numbers[index] == sorted_numbers[index - 1] + 1:
            consecutive += 1

    return {
        "sum": total,
        "span": maximum - minimum,
        "odd": odd,
        "even": len(sorted_numbers) - odd,
        "big": big,
        "small": len(sorted_numbers) - big,
        "zones": zones,
        "consecutive": consecutive,
    }


def summarize_targets(
    series: list[list[int]],
    *,
    window: int,
    pick_count: int,
    big_min: int,
    zone_limits: list[int],
) -> dict:
    sample = series[: min(window, len(series))]
    odd_even_counts: dict[str, int] = {}
    big_small_counts: dict[str, int] = {}
    zone_counts: dict[str, int] = {}
    valid_samples = 0
    total_sum = 0
    total_span = 0
    total_odd = 0
    total_big = 0
    zones = [0 for _ in zone_limits]

    for numbers in sample:
        indicators = compute_number_indicators(numbers, big_min=big_min, zone_limits=zone_limits)
        if not indicators:
            continue
        valid_samples += 1
        total_sum += indicators["sum"]
        total_span += indicators["span"]
        total_odd += indicators["odd"]
        total_big += indicators["big"]
        for index in range(len(zone_limits)):
            zones[index] += indicators["zones"][index]
        increment(odd_even_counts, f"{indicators['odd']}:{indicators['even']}")
        increment(big_small_counts, f"{indicators['big']}:{indicators['small']}")
        increment(zone_counts, ":".join(str(value) for value in indicators["zones"]))

    divisor = valid_samples or 1
    average_zones = [value / divisor for value in zones]
    half = round_half(pick_count / 2)

    return {
        "averageSum": total_sum / divisor,
        "averageSpan": total_span / divisor,
        "averageOdd": total_odd / divisor,
        "averageBig": total_big / divisor,
        "averageZones": average_zones,
        "commonOddEven": most_common(odd_even_counts, f"{half}:{pick_count - half}"),
        "commonBigSmall": most_common(big_small_counts, f"{half}:{pick_count - half}"),
        "commonZones": most_common(
            zone_counts,
            ":".join(str(round_half(value)) for value in average_zones),
        ),
    }


def allocate_zones(average_zones: list[float], target_count: int) -> list[int]:
    total = sum(average_zones) or 1
    exact = [(value / total) * target_count for value in average_zones]
    counts = [math.floor(value) for value in exact]
    remaining = target_count - sum(counts)

    order = sorted(
        ((value - math.floor(value), index) for index, value in enumerate(exact)),
        key=lambda item: (-item[0], item[1]),
    )
    for _fraction, index in order:
        if remaining <= 0:
            break
        counts[index] += 1
        remaining -= 1

    cursor = 0
    while remaining > 0 and counts:
        counts[cursor % len(counts)] += 1
        cursor += 1
        remaining -= 1

    return counts


def format_odd_even(indicators: dict) -> str:
    return f"{indicators['odd']}:{indicators['even']}"


def format_big_small(indicators: dict) -> str:
    return f"{indicators['big']}:{indicators['small']}"


def format_zones(indicators: dict) -> str:
    return ":".join(str(value) for value in indicators["zones"])


def pad2(value: int) -> str:
    return str(value).rjust(2, "0")


def round_half(value: float) -> int:
    return math.floor(value + 0.5)


def increment(counts: dict[str, int], key: str) -> None:
    counts[key] = counts.get(key, 0) + 1


def most_common(counts: dict[str, int], fallback: str) -> str:
    best_key = fallback
    best_count = 0
    for key, count in counts.items():
        if count > best_count or (count == best_count and key < best_key):
            best_key = key
            best_count = count
    return best_key
