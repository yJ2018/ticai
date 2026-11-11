"""快乐8号码推演（对齐 apps/api/src/analysis/kl8-recommendation.mjs）。

1–80 每期开 20 个号；按四区各 5 码组成 20 码参考池，再按近 30 期四区均值
把 10 个名额分配给四区，从池内取「选十」10 码主推。
"""

from __future__ import annotations

from .pool_utils import (
    POOL_WINDOWS,
    allocate_zones,
    compute_number_indicators,
    format_big_small,
    format_odd_even,
    format_zones,
    pad2,
    pick_zone_pool,
    rank_pool_numbers,
    summarize_targets,
    zone_index_of,
)

KL8_WINDOW = 300
DRAW_COUNT = 20
NUMBER_MIN = 1
NUMBER_MAX = 80
PRIMARY_COUNT = 10
ZONE_LIMITS = [20, 40, 60, 80]
POOL_PER_ZONE = 5
BIG_MIN = 41
MIN_SAMPLE = 30


def analyze_kl8_recommendation(entries: list[dict]) -> dict | None:
    draws = []
    for entry in entries[:KL8_WINDOW]:
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
    series = [draw["numbers"] for draw in draws]
    ranking = rank_pool_numbers(
        series,
        minimum=NUMBER_MIN,
        maximum=NUMBER_MAX,
        pick_per_draw=DRAW_COUNT,
        windows=windows,
    )

    pool = pick_zone_pool(ranking, zone_limits=ZONE_LIMITS, per_zone=POOL_PER_ZONE)
    targets = summarize_targets(
        series,
        window=windows["recent"],
        pick_count=DRAW_COUNT,
        big_min=BIG_MIN,
        zone_limits=ZONE_LIMITS,
    )

    allocation = allocate_zones(targets["averageZones"], PRIMARY_COUNT)
    primary = _pick_primary_numbers(ranking, pool, allocation)
    if len(primary) < PRIMARY_COUNT:
        return None

    pool_metrics = compute_number_indicators(pool, big_min=BIG_MIN, zone_limits=ZONE_LIMITS)
    metrics = compute_number_indicators(primary, big_min=BIG_MIN, zone_limits=ZONE_LIMITS)

    hot = sorted(
        ranking,
        key=lambda stat: (-stat["recentCount"], -stat["shortCount"], stat["number"]),
    )[:10]
    cold = sorted(
        ranking,
        key=lambda stat: (
            stat["recentCount"],
            -stat["missSpan"],
            stat["score"],
            stat["number"],
        ),
    )[:10]
    overdue = sorted(
        ranking,
        key=lambda stat: (-stat["missSpan"], stat["number"]),
    )[:10]

    return {
        "windows": windows,
        "sampleSize": len(draws),
        "picks": {
            "primary": primary,
            "pool": pool,
        },
        "allocation": allocation,
        "ranking": ranking,
        "hot": hot,
        "cold": cold,
        "overdue": overdue,
        "targets": targets,
        "metrics": metrics,
        "poolMetrics": pool_metrics,
        "reasons": _build_reasons(
            windows=windows,
            hot=hot,
            overdue=overdue,
            primary=primary,
            pool=pool,
            metrics=metrics,
            targets=targets,
            allocation=allocation,
        ),
    }


def _to_draw(entry: dict) -> dict | None:
    numbers = entry.get("numbers") if isinstance(entry, dict) else None
    if not isinstance(numbers, list) or len(numbers) < DRAW_COUNT:
        return None

    try:
        parsed = [int(value) for value in numbers[:DRAW_COUNT]]
    except (TypeError, ValueError):
        return None

    if any(value < NUMBER_MIN or value > NUMBER_MAX for value in parsed):
        return None
    if len(set(parsed)) != DRAW_COUNT:
        return None

    return {"numbers": sorted(parsed)}


def _pick_primary_numbers(ranking: list[dict], pool: list[int], allocation: list[int]) -> list[int]:
    pool_set = set(pool)
    by_zone: list[list[dict]] = [[] for _ in ZONE_LIMITS]
    for stat in ranking:
        if stat["number"] in pool_set:
            by_zone[zone_index_of(stat["number"], ZONE_LIMITS)].append(stat)

    picked: list[int] = []
    for zone in range(len(ZONE_LIMITS)):
        take = min(allocation[zone] if zone < len(allocation) else 0, len(by_zone[zone]))
        for index in range(take):
            picked.append(by_zone[zone][index]["number"])

    if len(picked) < PRIMARY_COUNT:
        picked_set = set(picked)
        for stat in ranking:
            if len(picked) >= PRIMARY_COUNT:
                break
            if stat["number"] not in picked_set:
                picked.append(stat["number"])
                picked_set.add(stat["number"])

    return sorted(picked[:PRIMARY_COUNT])


def _build_reasons(
    *,
    windows: dict,
    hot: list[dict],
    overdue: list[dict],
    primary: list[int],
    pool: list[int],
    metrics: dict,
    targets: dict,
    allocation: list[int],
) -> list[str]:
    expected_recent = (windows["recent"] * DRAW_COUNT) / (NUMBER_MAX - NUMBER_MIN + 1)
    hot_text = "、".join(
        f"{pad2(stat['number'])}（{stat['recentCount']} 次）" for stat in hot[:3]
    )
    overdue_text = "、".join(
        f"{pad2(stat['number'])}（遗漏 {stat['missSpan']} 期）" for stat in overdue[:3]
    )
    hot_expected_text = f"近 {windows['recent']} 期每号平均出现 {expected_recent:.1f} 次"

    return [
        f"近 {windows['recent']} 期热号：{hot_text}；{hot_expected_text}。",
        f"当前遗漏最久：{overdue_text}；冷号回补与热号延续各留了位置。",
        f"选十主推 {' '.join(pad2(number) for number in primary)}，和值 {metrics['sum']}、跨度 {metrics['span']}，"
        f"奇偶 {format_odd_even(metrics)}、大小 {format_big_small(metrics)}、四区 {format_zones(metrics)}、"
        f"连号 {metrics['consecutive']} 组；近 {windows['recent']} 期均值 "
        f"{targets['averageSum']:.1f} / {targets['averageSpan']:.1f}。",
        f"20 码参考池按四区各取 5 码；选十主推按近 {windows['recent']} 期四区均值分配为 "
        f"{':'.join(str(value) for value in allocation)}，从池内按评分取号。",
        "选十玩法理论命中期望 2.5 个（10 × 20 / 80），命中分布只作娱乐参考。",
    ]
