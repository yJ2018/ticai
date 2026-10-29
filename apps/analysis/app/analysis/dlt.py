"""大乐透 5+2 推演（Python 移植，逐行对齐 dlt-recommendation.mjs）。

输入按「期号倒序」排列的开奖记录，只取最近 300 期：
1. 统计每个号码的近 10 / 30 / 300 期出现次数与当前遗漏，得到综合评分；
2. 前区每个区取评分最高的 4 个组成 12 码候选池，枚举 5 码组合；
3. 用近 30 期的和值 / 跨度 / 奇偶 / 大小 / 三区均值给组合打分，兼顾评分与形态；
4. 后区取 5 码候选池，枚举 2 码组合；
5. 生成可解释的推演理由（与 Node 版逐字一致）。
"""

from __future__ import annotations

from itertools import combinations
from typing import Any, Callable

from .dlt_indicators import (
    DLT_BACK_MAX,
    DLT_BACK_MIN,
    DLT_FRONT_MAX,
    DLT_FRONT_MIN,
    compute_dlt_back_indicators,
    compute_dlt_front_indicators,
    format_dlt_big_small,
    format_dlt_odd_even,
    format_dlt_zones,
    get_dlt_front_zone_index,
    parse_dlt_back_numbers,
    parse_dlt_front_numbers,
)

FRONT_PICK_COUNT = 5
BACK_PICK_COUNT = 2
# 推演使用最近 300 期，兼顾稳定性与计算量
LONG_WINDOW = 300
# 热度窗口 / 短期热度窗口
RECENT_WINDOW = 30
SHORT_WINDOW = 10
# 少于 30 期不生成号码
MIN_SAMPLE = 30
# 前区每个区取评分最高的 4 个进入候选池；后区取评分最高的 5 个
ZONE_POOL_SIZE = 4
BACK_POOL_SIZE = 5


def _to_draw(entry: dict) -> dict | None:
    front = parse_dlt_front_numbers(entry.get("numbers") or [])
    back = parse_dlt_back_numbers(entry.get("numbers") or [])
    return {"front": front, "back": back} if front and back else None


def _pad(value: int) -> str:
    return f"{value:02d}"


def _rank_numbers(
    draws: list[dict],
    windows: dict,
    minimum: int,
    maximum: int,
    pick_per_draw: int,
    get_numbers: Callable[[dict], list[int]],
) -> list[dict]:
    """逐号码评分：短期 / 近期 / 长期频次按期望次数归一，遗漏按平均间隔归一（最多 3 倍）。"""
    domain_size = maximum - minimum + 1
    counts = [{"short": 0, "recent": 0, "long": 0, "miss": None} for _ in range(domain_size)]

    for index, draw in enumerate(draws):
        for number in get_numbers(draw):
            if number < minimum or number > maximum:
                continue
            count = counts[number - minimum]
            count["long"] += 1
            if index < windows["short"]:
                count["short"] += 1
            if index < windows["recent"]:
                count["recent"] += 1
            if count["miss"] is None:
                count["miss"] = index

    expected_short = max((windows["short"] * pick_per_draw) / domain_size, 1e-6)
    expected_recent = max((windows["recent"] * pick_per_draw) / domain_size, 1e-6)
    expected_long = max((windows["long"] * pick_per_draw) / domain_size, 1e-6)
    expected_gap = domain_size / pick_per_draw

    stats = []
    for index, count in enumerate(counts):
        number = minimum + index
        miss_span = windows["long"] if count["miss"] is None else count["miss"]
        # 频次 / 遗漏权重：近 10 期热度 30%、近 30 期 25%、长期 20%、遗漏 25%
        score = (
            0.3 * (count["short"] / expected_short)
            + 0.25 * (count["recent"] / expected_recent)
            + 0.2 * (count["long"] / expected_long)
            + 0.25 * min(miss_span / expected_gap, 3)
        )
        stats.append(
            {
                "number": number,
                "score": score,
                "shortCount": count["short"],
                "recentCount": count["recent"],
                "longCount": count["long"],
                "missSpan": miss_span,
            }
        )

    stats.sort(key=lambda item: (-item["score"], -item["missSpan"], item["number"]))
    return stats


def _increment(counts: dict[str, int], key: str) -> None:
    counts[key] = counts.get(key, 0) + 1


def _most_common(counts: dict[str, int], fallback: str) -> str:
    best_key = fallback
    best_count = 0
    for key, count in counts.items():
        if count > best_count or (count == best_count and key < best_key):
            best_key = key
            best_count = count
    return best_key


def _compute_targets(draws: list[dict], window: int) -> dict:
    sample = draws[:window]
    odd_even_counts: dict[str, int] = {}
    big_small_counts: dict[str, int] = {}
    zone_counts: dict[str, int] = {}
    valid_samples = 0
    total_sum = 0
    total_span = 0
    total_odd = 0
    total_big = 0
    zone0 = zone1 = zone2 = 0
    back_sum = back_span = back_odd = 0

    for draw in sample:
        front = compute_dlt_front_indicators(draw["front"])
        back = compute_dlt_back_indicators(draw["back"])
        if not front or not back:
            continue
        valid_samples += 1
        total_sum += front["sum"]
        total_span += front["span"]
        total_odd += front["odd"]
        total_big += front["big"]
        zone0 += front["zones"][0]
        zone1 += front["zones"][1]
        zone2 += front["zones"][2]
        back_sum += back["sum"]
        back_span += back["span"]
        back_odd += back["odd"]
        _increment(odd_even_counts, format_dlt_odd_even(front))
        _increment(big_small_counts, format_dlt_big_small(front))
        _increment(zone_counts, format_dlt_zones(front))

    divisor = valid_samples or 1
    return {
        "averageSum": total_sum / divisor,
        "averageSpan": total_span / divisor,
        "averageOdd": total_odd / divisor,
        "averageBig": total_big / divisor,
        "averageZones": [zone0 / divisor, zone1 / divisor, zone2 / divisor],
        "commonOddEven": _most_common(odd_even_counts, "3:2"),
        "commonBigSmall": _most_common(big_small_counts, "2:3"),
        "commonZones": _most_common(zone_counts, "1:2:2"),
        "averageBackSum": back_sum / divisor,
        "averageBackSpan": back_span / divisor,
        "averageBackOdd": back_odd / divisor,
    }


def _pick_zone_candidates(stats: list[dict]) -> list[dict]:
    by_zone: list[list[dict]] = [[], [], []]
    for stat in stats:
        by_zone[get_dlt_front_zone_index(stat["number"])].append(stat)
    pool: list[dict] = []
    for zone_stats in by_zone:
        pool.extend(zone_stats[:ZONE_POOL_SIZE])
    return pool


def _count_consecutive_triples(numbers: list[int]) -> int:
    ordered = sorted(numbers)
    triples = 0
    run_length = 1
    for index in range(1, len(ordered)):
        if ordered[index] == ordered[index - 1] + 1:
            run_length += 1
            continue
        if run_length >= 3:
            triples += run_length - 2
        run_length = 1
    if run_length >= 3:
        triples += run_length - 2
    return triples


def _pick_front_combination(
    pool: list[dict], stats: list[dict], targets: dict, last_front: list[int]
) -> dict | None:
    stat_by_number = {stat["number"]: stat for stat in stats}
    last_draw_set = set(last_front)
    pool_numbers = [stat["number"] for stat in pool]
    best: dict | None = None
    best_sum_distance = float("inf")

    for chosen in combinations(range(len(pool_numbers)), 5):
        numbers = sorted(pool_numbers[index] for index in chosen)
        metrics = compute_dlt_front_indicators(numbers)
        if not metrics:
            continue
        base_score = sum(stat_by_number.get(number, {}).get("score", 0) for number in numbers) / len(numbers)
        sum_distance = abs(metrics["sum"] - targets["averageSum"])
        zone_distance = (
            abs(metrics["zones"][0] - targets["averageZones"][0])
            + abs(metrics["zones"][1] - targets["averageZones"][1])
            + abs(metrics["zones"][2] - targets["averageZones"][2])
        )
        overlap = sum(1 for number in numbers if number in last_draw_set)
        # 组合分：5 个号码的平均评分占主导，和值/跨度/奇偶/大小/三区/连号偏差做软约束
        score = (
            base_score * 1.6
            - sum_distance / 45
            - abs(metrics["span"] - targets["averageSpan"]) / 18
            - abs(metrics["odd"] - targets["averageOdd"]) * 0.1
            - abs(metrics["big"] - targets["averageBig"]) * 0.1
            - zone_distance * 0.1
            - _count_consecutive_triples(numbers) * 0.15
            - max(0, overlap - 2) * 0.1
        )
        if (
            best is None
            or score > best["score"] + 1e-9
            or (abs(score - best["score"]) <= 1e-9 and sum_distance < best_sum_distance - 1e-9)
        ):
            best = {"numbers": numbers, "metrics": metrics, "score": score}
            best_sum_distance = sum_distance

    return best


def _pick_back_combination(pool: list[dict], stats: list[dict], targets: dict, last_back: list[int]) -> dict | None:
    stat_by_number = {stat["number"]: stat for stat in stats}
    last_draw_set = set(last_back)
    best: dict | None = None
    best_sum_distance = float("inf")

    for first, second in combinations(range(len(pool)), 2):
        numbers = sorted([pool[first]["number"], pool[second]["number"]])
        metrics = compute_dlt_back_indicators(numbers)
        if not metrics:
            continue
        base_score = sum(stat_by_number.get(number, {}).get("score", 0) for number in numbers) / len(numbers)
        sum_distance = abs(metrics["sum"] - targets["averageBackSum"])
        overlap = sum(1 for number in numbers if number in last_draw_set)
        # 后区组合同样以评分为主，和值/跨度/奇偶偏差与重复上期做软约束
        score = (
            base_score * 1.6
            - sum_distance / 10
            - abs(metrics["span"] - targets["averageBackSpan"]) / 6
            - abs(metrics["odd"] - targets["averageBackOdd"]) * 0.12
            - max(0, overlap - 1) * 0.1
        )
        if (
            best is None
            or score > best["score"] + 1e-9
            or (abs(score - best["score"]) <= 1e-9 and sum_distance < best_sum_distance - 1e-9)
        ):
            best = {"numbers": numbers, "metrics": metrics, "score": score}
            best_sum_distance = sum_distance

    return best


def _build_reasons(
    *,
    front_stats: list[dict],
    back_stats: list[dict],
    front_metrics: dict,
    back_metrics: dict,
    picks: dict,
    targets: dict,
    windows: dict,
) -> list[str]:
    front_stat_by_number = {stat["number"]: stat for stat in front_stats}
    back_stat_by_number = {stat["number"]: stat for stat in back_stats}
    reasons: list[str] = []

    front_by_heat = sorted(
        picks["front"],
        key=lambda number: (
            -(front_stat_by_number.get(number) or {}).get("recentCount", 0),
            -(front_stat_by_number.get(number) or {}).get("shortCount", 0),
            number,
        ),
    )
    front_by_miss = sorted(
        picks["front"],
        key=lambda number: (-(front_stat_by_number.get(number) or {}).get("missSpan", 0), number),
    )

    hot_front = front_by_heat[0]
    due_front = front_by_miss[0]
    hot_front_stat = front_stat_by_number.get(hot_front)
    due_front_stat = front_stat_by_number.get(due_front)

    expected_recent_front = (windows["recent"] * FRONT_PICK_COUNT) / (DLT_FRONT_MAX - DLT_FRONT_MIN + 1)
    average_gap_front = (DLT_FRONT_MAX - DLT_FRONT_MIN + 1) / FRONT_PICK_COUNT
    hot_front_text = (
        f"{_pad(hot_front)} 近 {windows['recent']} 期出现 {(hot_front_stat or {}).get('recentCount', 0)} 次"
        f"（均值 {expected_recent_front:.1f} 次）"
    )
    due_front_miss = (due_front_stat or {}).get("missSpan", 0)
    due_front_text = (
        f"{_pad(due_front)} 近 {windows['long']} 期未出现"
        if due_front_stat and due_front_miss >= windows["long"]
        else f"{_pad(due_front)} 已遗漏 {due_front_miss} 期（平均 {average_gap_front:.0f} 期一出）"
    )
    has_due_front = bool(due_front_stat and due_front_miss >= average_gap_front)

    if hot_front == due_front:
        due_span_text = (
            f"近 {windows['long']} 期未出现"
            if due_front_stat and due_front_miss >= windows["long"]
            else f"当前遗漏 {due_front_miss} 期"
        )
        reasons.append(
            f"前区 {_pad(hot_front)} 近 {windows['recent']} 期出现 "
            f"{(hot_front_stat or {}).get('recentCount', 0)} 次，在入选号中热度最高；"
            f"{due_span_text}{'，也进入回补区间' if has_due_front else ''}。"
        )
    else:
        due_clause = (
            f"回补号 {due_front_text}"
            if has_due_front
            else f"其余入选号最长遗漏 {due_front_miss} 期"
        )
        reasons.append(f"前区热号 {hot_front_text}；{due_clause}。")

    sum_distance = abs(front_metrics["sum"] - targets["averageSum"])
    span_distance = abs(front_metrics["span"] - targets["averageSpan"])
    zone_distance = (
        abs(front_metrics["zones"][0] - targets["averageZones"][0])
        + abs(front_metrics["zones"][1] - targets["averageZones"][1])
        + abs(front_metrics["zones"][2] - targets["averageZones"][2])
    )
    closeness_text = "接近" if sum_distance <= 12 and span_distance <= 6 else "参考"
    shape_text = "形态保持均衡" if zone_distance <= 1.5 else "形态相对集中"
    reasons.append(
        f"组合和值 {front_metrics['sum']}、跨度 {front_metrics['span']}，{closeness_text}近 "
        f"{windows['recent']} 期均值 {targets['averageSum']:.1f} / {targets['averageSpan']:.1f}；"
        f"奇偶 {format_dlt_odd_even(front_metrics)}、大小 {format_dlt_big_small(front_metrics)}、"
        f"三区 {format_dlt_zones(front_metrics)}，{shape_text}（近 {windows['recent']} 期主流 "
        f"{targets['commonOddEven']} / {targets['commonBigSmall']} / {targets['commonZones']}）。"
    )

    back_by_heat = sorted(
        picks["back"],
        key=lambda number: (
            -(back_stat_by_number.get(number) or {}).get("recentCount", 0),
            -(back_stat_by_number.get(number) or {}).get("shortCount", 0),
            number,
        ),
    )
    back_by_miss = sorted(
        picks["back"],
        key=lambda number: (-(back_stat_by_number.get(number) or {}).get("missSpan", 0), number),
    )
    hot_back = back_by_heat[0]
    due_back = back_by_miss[0]
    hot_back_stat = back_stat_by_number.get(hot_back)
    due_back_stat = back_stat_by_number.get(due_back)
    expected_recent_back = (windows["recent"] * BACK_PICK_COUNT) / (DLT_BACK_MAX - DLT_BACK_MIN + 1)
    due_back_clause = (
        "同时是入选后区中遗漏最久的号码"
        if hot_back == due_back
        else f"{_pad(due_back)} 已遗漏 {(due_back_stat or {}).get('missSpan', 0)} 期"
    )
    reasons.append(
        f"后区 {_pad(hot_back)} 近 {windows['recent']} 期 {(hot_back_stat or {}).get('recentCount', 0)} 次"
        f"（均值 {expected_recent_back:.1f} 次），{due_back_clause}；"
        f"组合奇偶 {format_dlt_odd_even(back_metrics)}、跨度 {back_metrics['span']}。"
    )
    return reasons


def analyze_dlt_recommendation(entries: list[dict]) -> dict | None:
    draws = []
    for entry in entries[:LONG_WINDOW]:
        draw = _to_draw(entry)
        if draw is not None:
            draws.append(draw)

    if len(draws) < MIN_SAMPLE:
        return None

    windows = {
        "short": min(SHORT_WINDOW, len(draws)),
        "recent": min(RECENT_WINDOW, len(draws)),
        "long": len(draws),
    }

    front_stats = _rank_numbers(
        draws, windows, DLT_FRONT_MIN, DLT_FRONT_MAX, FRONT_PICK_COUNT, lambda draw: draw["front"]
    )
    back_stats = _rank_numbers(
        draws, windows, DLT_BACK_MIN, DLT_BACK_MAX, BACK_PICK_COUNT, lambda draw: draw["back"]
    )
    targets = _compute_targets(draws, windows["recent"])
    front_pool = _pick_zone_candidates(front_stats)
    back_pool = back_stats[:BACK_POOL_SIZE]
    last_draw = draws[0]

    front_combination = _pick_front_combination(front_pool, front_stats, targets, last_draw["front"])
    back_combination = _pick_back_combination(back_pool, back_stats, targets, last_draw["back"])
    if not front_combination or not back_combination:
        return None

    picked_front = set(front_combination["numbers"])
    picked_back = set(back_combination["numbers"])
    front_pool_set = {stat["number"] for stat in front_pool}

    alternates_front = sorted(
        [
            stat["number"]
            for stat in front_stats
            if stat["number"] in front_pool_set and stat["number"] not in picked_front
        ][:5]
    )
    alternates_back = sorted(
        [stat["number"] for stat in back_stats if stat["number"] not in picked_back][:3]
    )

    return {
        "windows": windows,
        "picks": {
            "front": front_combination["numbers"],
            "back": back_combination["numbers"],
        },
        "alternates": {
            "front": alternates_front,
            "back": alternates_back,
        },
        "metrics": {
            "front": front_combination["metrics"],
            "back": back_combination["metrics"],
        },
        "targets": targets,
        "reasons": _build_reasons(
            front_stats=front_stats,
            back_stats=back_stats,
            front_metrics=front_combination["metrics"],
            back_metrics=back_combination["metrics"],
            picks={
                "front": front_combination["numbers"],
                "back": back_combination["numbers"],
            },
            targets=targets,
            windows=windows,
        ),
    }
