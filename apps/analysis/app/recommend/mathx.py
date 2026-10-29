"""推荐引擎的数学层（Python 移植版，逐行对齐 apps/api/src/recommend/math.mjs）。

口径：
   官方赔率 → 幂法去水得到市场概率 → 用市场概率反推 λ（预期进球）
   → Dixon-Coles 比分矩阵 → 各玩法概率。

为什么用幂法去水（p_i = (1/o_i)^k，Σp_i = 1）而不是简单归一：
   简单归一把庄家的抽水按比例摊，会系统性高估长赔（低概率）选项，
   于是「模型概率 > 市场概率」永远出现在冷门上——这正是旧的客户端推荐
   会挑出 22.00 这种票的原因之一。

为什么不用 numpy：依赖越少，Vercel 冷启动越短。λ 拟合用「泊松 CDF + 卷积」
代替逐格构造 9×9 矩阵，单场从 ~1 万次矩阵操作降到几十次，纯 Python 也够快。
"""

from __future__ import annotations

import math
import re

MAX_GOALS = 8

_pmf_cache: dict[tuple[float, int], list[float]] = {}


def poisson_pmf(lam: float, maximum: int = MAX_GOALS) -> list[float]:
    key = (round(lam, 6), maximum)
    cached = _pmf_cache.get(key)
    if cached is not None:
        return cached

    out = [0.0] * (maximum + 1)
    term = math.exp(-lam)
    out[0] = term
    for k in range(1, maximum + 1):
        term = term * lam / k
        out[k] = term
    _pmf_cache[key] = out
    return out


def _cdf(pmf: list[float]) -> list[float]:
    out = [0.0] * len(pmf)
    acc = 0.0
    for index, value in enumerate(pmf):
        acc += value
        out[index] = acc
    return out


def devig(odds: list[float]) -> list[float] | None:
    """幂法去水。赔率 < 2 项或含非法值时返回 None（调用方跳过该组）。"""
    valid = [o for o in odds if isinstance(o, (int, float)) and math.isfinite(o) and o > 1]
    if len(valid) != len(odds) or len(valid) < 2:
        return None

    raw = [1.0 / value for value in valid]

    def sum_at(k: float) -> float:
        return sum(value**k for value in raw)

    # k=1 时 Σ(1/o) > 1（含水），k 增大则单调下降；二分找到 Σ = 1
    low, high = 0.5, 4.0
    if sum_at(low) < 1:
        # 赔率异常（含水为负），退化为比例归一
        total = sum(raw)
        return [value / total for value in raw]

    for _ in range(60):
        mid = (low + high) / 2
        if sum_at(mid) > 1:
            low = mid
        else:
            high = mid
    k = (low + high) / 2
    return [value**k for value in raw]


def score_matrix(
    lambda_home: float,
    lambda_away: float,
    *,
    maximum: int = MAX_GOALS,
    rho: float = -0.05,
) -> list[list[float]]:
    """Dixon-Coles 比分矩阵：独立泊松 + 低比分相关性修正（rho < 0 抬高 0:0 / 1:1）。"""
    home = poisson_pmf(lambda_home, maximum)
    away = poisson_pmf(lambda_away, maximum)

    matrix: list[list[float]] = []
    total = 0.0
    for h in range(maximum + 1):
        row = [0.0] * (maximum + 1)
        for a in range(maximum + 1):
            probability = home[h] * away[a]
            if h == 0 and a == 0:
                probability *= 1 - lambda_home * lambda_away * rho
            elif h == 0 and a == 1:
                probability *= 1 + lambda_home * rho
            elif h == 1 and a == 0:
                probability *= 1 + lambda_away * rho
            elif h == 1 and a == 1:
                probability *= 1 - rho
            row[a] = max(probability, 0.0)
            total += row[a]
        matrix.append(row)

    if total > 0:
        for row in matrix:
            for index in range(len(row)):
                row[index] /= total
    return matrix


_GOAL_LINE_CLEAN = re.compile(r"[^0-9+.\-]")


def parse_goal_line(value: object) -> float:
    """让球线：体彩 hhad.goalLine 形如 "+1" / "-1"，空串按 0 处理。"""
    text = _GOAL_LINE_CLEAN.sub("", str(value if value is not None else ""))
    try:
        parsed = float(text)
    except ValueError:
        return 0.0
    return parsed if math.isfinite(parsed) else 0.0


def pool_probabilities(matrix: list[list[float]], goal_line: float = 0) -> dict[str, dict[str, float]]:
    """比分矩阵 → 推荐用到的三个玩法概率（胜平负 / 让球胜平负 / 总进球）。"""
    had = {"h": 0.0, "d": 0.0, "a": 0.0}
    hhad = {"h": 0.0, "d": 0.0, "a": 0.0}
    ttg = {f"s{index}": 0.0 for index in range(8)}

    for h, row in enumerate(matrix):
        for a, probability in enumerate(row):
            if probability <= 0:
                continue
            if h > a:
                had["h"] += probability
            elif h == a:
                had["d"] += probability
            else:
                had["a"] += probability

            diff = h + goal_line - a
            if diff > 0:
                hhad["h"] += probability
            elif diff == 0:
                hhad["d"] += probability
            else:
                hhad["a"] += probability

            total = h + a
            ttg["s7" if total >= 7 else f"s{total}"] += probability

    return {"had": had, "hhad": hhad, "ttg": ttg}


def _had_ttg_from_pmfs(
    lambda_home: float,
    lambda_away: float,
    goal_line: float,
    maximum: int = MAX_GOALS,
) -> tuple[dict[str, float], dict[str, float]] | None:
    """不构造矩阵，直接用 CDF + 卷积算胜平负与总进球（拟合时用，等价于矩阵求和）。

    让球线是整数（体彩让球只有整数）时走快路径；非整数回落到矩阵。
    """
    if goal_line != int(goal_line):
        return None

    home = poisson_pmf(lambda_home, maximum)
    away = poisson_pmf(lambda_away, maximum)
    cdf_home = _cdf(home)

    had = {"h": 0.0, "d": 0.0, "a": 0.0}
    for a, probability_away in enumerate(away):
        if probability_away <= 0:
            continue
        # P(h > a) = 1 - P(h <= a)，P(h == a) = pmf[h=a]，P(h < a) = P(h <= a) - pmf[h=a]
        had["h"] += probability_away * (1 - cdf_home[a])
        had["d"] += probability_away * home[a]
        had["a"] += probability_away * (cdf_home[a] - home[a])

    ttg = {f"s{index}": 0.0 for index in range(8)}
    for a, probability_away in enumerate(away):
        if probability_away <= 0:
            continue
        for h, probability_home in enumerate(home):
            total = h + a
            ttg["s7" if total >= 7 else f"s{total}"] += probability_away * probability_home

    return had, ttg


def _fit_error(
    lambda_home: float,
    lambda_away: float,
    had_target: dict[str, float] | None,
    ttg_target: dict[str, float] | None,
    goal_line: float,
) -> float:
    """与 Node 版完全同一套误差：CDF + 卷积快路径（不构造矩阵）。

    `goal_line` 不参与：拟合目标只有胜平负与总进球，让球概率不影响 λ。
    早期 Python 用快路径、Node 用矩阵，截断与归一化顺序不同，会让 λ 落在相邻格点
    （实测 0.98 vs 0.97、总进球期望差 0.01）；现在两边都走同一套快路径。
    """
    fast = _had_ttg_from_pmfs(lambda_home, lambda_away, 0)
    if fast is None:  # pragma: no cover - 0 恒为整数，理论到不了
        probs = pool_probabilities(score_matrix(lambda_home, lambda_away, rho=0), goal_line)
        had, ttg = probs["had"], probs["ttg"]
    else:
        had, ttg = fast

    score = 0.0
    if had_target is not None:
        for key in ("h", "d", "a"):
            delta = had[key] - had_target[key]
            score += delta * delta
    if ttg_target is not None:
        for index in range(8):
            key = f"s{index}"
            delta = ttg[key] - ttg_target.get(key, 0.0)
            score += 0.6 * delta * delta
    return score


def fit_lambdas(
    had_target: dict[str, float] | None,
    ttg_target: dict[str, float] | None,
    goal_line: float = 0,
) -> dict[str, float] | None:
    """由市场概率反推 λ：粗网格全扫 + 局部细化，目标 = 胜平负 + 总进球。"""
    if had_target is None and ttg_target is None:
        return None

    best = {"home": 1.3, "away": 1.1, "error": math.inf}
    for h in range(40, 321, 8):
        for a in range(30, 301, 8):
            value = _fit_error(h / 100, a / 100, had_target, ttg_target, goal_line)
            if value < best["error"]:
                best = {"home": h / 100, "away": a / 100, "error": value}

    for dh in range(-7, 8):
        for da in range(-7, 8):
            lambda_home = max(0.2, best["home"] + dh / 100)
            lambda_away = max(0.2, best["away"] + da / 100)
            value = _fit_error(lambda_home, lambda_away, had_target, ttg_target, goal_line)
            if value < best["error"]:
                best = {"home": lambda_home, "away": lambda_away, "error": value}

    return {
        "home": round(best["home"], 3),
        "away": round(best["away"], 3),
        "error": round(math.sqrt(best["error"]), 5),
    }


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(max(value, minimum), maximum)
