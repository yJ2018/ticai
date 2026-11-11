"""双色球号码推演（对齐 apps/api/src/analysis/ssq-recommendation.mjs）。

红球 1–33 选 6、蓝球 1–16 选 1；取最近 300 期，按近 10 / 30 / 100 期频次与遗漏评分，
红球三区各取 4 码组成 12 码池，再从池内枚举 6 码做形态软约束，选出主推单注。
"""

from __future__ import annotations

from .pool_utils import (
    POOL_WINDOWS,
    compute_number_indicators,
    format_big_small,
    format_odd_even,
    format_zones,
    pad2,
    pick_zone_pool,
    rank_pool_numbers,
    summarize_targets,
)

SSQ_WINDOW = 300
RED_COUNT = 6
RED_MIN = 1
RED_MAX = 33
BLUE_COUNT = 1
BLUE_MIN = 1
BLUE_MAX = 16
RED_ZONE_LIMITS = [11, 22, 33]
RED_PER_ZONE = 4
BLUE_POOL_SIZE = 4
RED_BIG_MIN = 17
BLUE_BIG_MIN = 9
MIN_SAMPLE = 30


def analyze_ssq_recommendation(entries: list[dict]) -> dict | None:
    draws = []
    for entry in entries[:SSQ_WINDOW]:
        draw = _to_draw(entry)
        if draw is not None:
            draws.append(draw)

    if len(draws) < MIN_SAMPLE:
        return None

    windows = {
        "short": min(POOL_WINDOWS["short"], len(draws)),
        "recent": min(POOL_WINDOWS["recent"], len(draws)),
        "long": min(POOL_WINDOWS["long"], len(draws)),
    }
    red_series = [draw["red"] for draw in draws]
    blue_series = [draw["blue"] for draw in draws]

    last_red = red_series[0]
    last_red_set = set(last_red)
    neighbor_set: set[int] = set()
    for number in last_red:
        if number - 1 >= RED_MIN:
            neighbor_set.add(number - 1)
        if number + 1 <= RED_MAX:
            neighbor_set.add(number + 1)

    red_ranking = rank_pool_numbers(
        red_series,
        minimum=RED_MIN,
        maximum=RED_MAX,
        pick_per_draw=RED_COUNT,
        windows=windows,
        repeat_set=last_red_set,
        neighbor_set=neighbor_set,
    )
    blue_ranking = rank_pool_numbers(
        blue_series,
        minimum=BLUE_MIN,
        maximum=BLUE_MAX,
        pick_per_draw=BLUE_COUNT,
        windows=windows,
    )

    red_pool = pick_zone_pool(red_ranking, zone_limits=RED_ZONE_LIMITS, per_zone=RED_PER_ZONE)
    blue_pool = [stat["number"] for stat in blue_ranking[:BLUE_POOL_SIZE]]
    blue_pool_sorted = sorted(blue_pool)

    red_targets = summarize_targets(
        red_series,
        window=windows["recent"],
        pick_count=RED_COUNT,
        big_min=RED_BIG_MIN,
        zone_limits=RED_ZONE_LIMITS,
    )
    primary_red = _pick_red_combination(red_pool, red_ranking, red_targets, last_red_set)
    if primary_red is None:
        return None

    primary_blue = blue_ranking[0]["number"] if blue_ranking else blue_pool_sorted[0]
    red_stats_by_number = {stat["number"]: stat for stat in red_ranking}
    blue_stats_by_number = {stat["number"]: stat for stat in blue_ranking}
    red_primary_set = set(primary_red["numbers"])

    red_hot = sorted(
        red_ranking,
        key=lambda stat: (-stat["recentCount"], -stat["shortCount"], stat["number"]),
    )[:5]
    red_cold = sorted(
        red_ranking,
        key=lambda stat: (
            stat["recentCount"],
            -stat["missSpan"],
            stat["score"],
            stat["number"],
        ),
    )[:5]
    red_overdue = sorted(
        red_ranking,
        key=lambda stat: (-stat["missSpan"], stat["number"]),
    )[:5]
    red_pool_set = set(red_pool)
    red_alternates = sorted(
        [
            stat["number"]
            for stat in red_ranking
            if stat["number"] not in red_primary_set and stat["number"] in red_pool_set
        ][:6]
    )

    blue_primary_set = {primary_blue}
    blue_alternates = sorted(
        [
            stat["number"]
            for stat in blue_ranking
            if stat["number"] not in blue_primary_set
        ][: BLUE_POOL_SIZE - 1]
    )
    blue_hot = sorted(
        blue_ranking,
        key=lambda stat: (-stat["recentCount"], -stat["shortCount"], stat["number"]),
    )[:4]
    blue_cold = sorted(
        blue_ranking,
        key=lambda stat: (
            stat["recentCount"],
            -stat["missSpan"],
            stat["score"],
            stat["number"],
        ),
    )[:4]
    blue_overdue = sorted(
        blue_ranking,
        key=lambda stat: (-stat["missSpan"], stat["number"]),
    )[:4]

    red_metrics = primary_red["metrics"]
    blue_value = int(primary_blue)
    blue_metrics = {
        "odd": blue_value % 2,
        "even": 0 if blue_value % 2 == 1 else 1,
        "big": 1 if blue_value >= BLUE_BIG_MIN else 0,
        "small": 0 if blue_value >= BLUE_BIG_MIN else 1,
    }

    return {
        "windows": windows,
        "sampleSize": len(draws),
        "red": {
            "poolSize": len(red_pool),
            "picks": red_pool,
            "primary": primary_red["numbers"],
            "alternates": red_alternates,
            "ranking": red_ranking,
            "hot": red_hot,
            "cold": red_cold,
            "overdue": red_overdue,
            "targets": red_targets,
            "metrics": red_metrics,
        },
        "blue": {
            "poolSize": len(blue_pool_sorted),
            "picks": blue_pool_sorted,
            "primary": [blue_value],
            "alternates": blue_alternates,
            "ranking": blue_ranking,
            "hot": blue_hot,
            "cold": blue_cold,
            "overdue": blue_overdue,
            "metrics": blue_metrics,
        },
        "reasons": _build_reasons(
            windows=windows,
            red_hot=red_hot[0] if red_hot else None,
            red_overdue=red_overdue[0] if red_overdue else None,
            blue_stats=blue_stats_by_number.get(primary_blue),
            blue_pool=blue_pool_sorted,
            red_metrics=red_metrics,
            red_targets=red_targets,
            red_pool=red_pool,
            last_red_set=last_red_set,
            primary_red=primary_red["numbers"],
            red_stats_by_number=red_stats_by_number,
            primary_blue=primary_blue,
        ),
    }


def _to_draw(entry: dict) -> dict | None:
    numbers = entry.get("numbers") if isinstance(entry, dict) else None
    if not isinstance(numbers, list) or len(numbers) < RED_COUNT + BLUE_COUNT:
        return None

    try:
        red = [int(value) for value in numbers[:RED_COUNT]]
        blue = [int(value) for value in numbers[RED_COUNT : RED_COUNT + BLUE_COUNT]]
    except (TypeError, ValueError):
        return None

    if any(value < RED_MIN or value > RED_MAX for value in red):
        return None
    if any(value < BLUE_MIN or value > BLUE_MAX for value in blue):
        return None

    return {"red": sorted(red), "blue": blue}


def _pick_red_combination(
    pool: list[int],
    ranking: list[dict],
    targets: dict,
    last_red_set: set[int],
) -> dict | None:
    stat_by_number = {stat["number"]: stat for stat in ranking}
    numbers = sorted(pool)
    if len(numbers) < RED_COUNT:
        return None

    best: dict | None = None
    best_sum_distance = float("inf")

    for first in range(0, len(numbers) - 5):
        for second in range(first + 1, len(numbers) - 4):
            for third in range(second + 1, len(numbers) - 3):
                for fourth in range(third + 1, len(numbers) - 2):
                    for fifth in range(fourth + 1, len(numbers) - 1):
                        for sixth in range(fifth + 1, len(numbers)):
                            combination = [
                                numbers[first],
                                numbers[second],
                                numbers[third],
                                numbers[fourth],
                                numbers[fifth],
                                numbers[sixth],
                            ]
                            metrics = compute_number_indicators(
                                combination,
                                big_min=RED_BIG_MIN,
                                zone_limits=RED_ZONE_LIMITS,
                            )
                            if metrics is None:
                                continue
                            base_score = sum(
                                stat_by_number.get(number, {}).get("score", 0.0)
                                for number in combination
                            ) / len(combination)
                            sum_distance = abs(metrics["sum"] - targets["averageSum"])
                            zone_distance = (
                                abs(metrics["zones"][0] - targets["averageZones"][0])
                                + abs(metrics["zones"][1] - targets["averageZones"][1])
                                + abs(metrics["zones"][2] - targets["averageZones"][2])
                            )
                            overlap = sum(1 for number in combination if number in last_red_set)
                            score = (
                                base_score * 1.6
                                - sum_distance / 45
                                - abs(metrics["span"] - targets["averageSpan"]) / 12
                                - abs(metrics["odd"] - targets["averageOdd"]) * 0.08
                                - abs(metrics["big"] - targets["averageBig"]) * 0.08
                                - zone_distance * 0.12
                                - metrics["consecutive"] * 0.06
                                - max(0, overlap - 2) * 0.08
                            )

                            if (
                                best is None
                                or score > best["score"] + 1e-9
                                or (
                                    abs(score - best["score"]) <= 1e-9
                                    and sum_distance < best_sum_distance - 1e-9
                                )
                            ):
                                best = {"numbers": combination, "metrics": metrics, "score": score}
                                best_sum_distance = sum_distance

    return best


def _build_reasons(
    *,
    windows: dict,
    red_hot: dict | None,
    red_overdue: dict | None,
    blue_stats: dict | None,
    blue_pool: list[int],
    red_metrics: dict,
    red_targets: dict,
    red_pool: list[int],
    last_red_set: set[int],
    primary_red: list[int],
    red_stats_by_number: dict[int, dict],
    primary_blue: int,
) -> list[str]:
    expected_recent_red = (windows["recent"] * RED_COUNT) / (RED_MAX - RED_MIN + 1)
    average_gap_red = (RED_MAX - RED_MIN + 1) / RED_COUNT
    hot_text = (
        f"{pad2(red_hot['number'])} 近 {windows['recent']} 期出现 {red_hot['recentCount']} 次"
        f"（均值 {expected_recent_red:.1f} 次）"
        if red_hot
        else "样本不足"
    )
    overdue_text = (
        f"{pad2(red_overdue['number'])} 已遗漏 {red_overdue['missSpan']} 期"
        f"（平均 {average_gap_red:.1f} 期一出）"
        if red_overdue
        else "暂无"
    )

    repeats = sum(1 for number in red_pool if number in last_red_set)
    primary_hot = " / ".join(
        pad2(number)
        for number in sorted(
            primary_red,
            key=lambda number: (
                -red_stats_by_number.get(number, {}).get("recentCount", 0),
                number,
            ),
        )[:3]
    )
    blue_text = (
        f"，近 {windows['recent']} 期出现 {blue_stats['recentCount']} 次"
        f"、当前遗漏 {blue_stats['missSpan']} 期"
        if blue_stats
        else ""
    )

    return [
        f"红球热号 {hot_text}；{overdue_text}。",
        f"主推红球 {' '.join(pad2(number) for number in primary_red)}，和值 {red_metrics['sum']}、跨度 {red_metrics['span']}，"
        f"奇偶 {format_odd_even(red_metrics)}、大小 {format_big_small(red_metrics)}、三区 {format_zones(red_metrics)}；"
        f"近 {windows['recent']} 期均值 {red_targets['averageSum']:.1f} / {red_targets['averageSpan']:.1f}。",
        f"红球池按一区 1–11、二区 12–22、三区 23–33 各取 4 码，兼顾区间均衡与冷热回补；"
        f"池内上一期重号 {repeats} 个，主推中近 {windows['recent']} 期较热的号码为 {primary_hot}。",
        f"蓝球主推 {pad2(primary_blue)}{blue_text}；蓝球 {BLUE_POOL_SIZE} 码池："
        f"{' / '.join(pad2(number) for number in blue_pool)}。",
    ]
