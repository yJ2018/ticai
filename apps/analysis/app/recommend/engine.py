"""投注推荐引擎（Python 移植版，逐行对齐 apps/api/src/recommend/engine.mjs）。

目标不是「猜中」，而是别把明显不成立的东西推给用户：

  1. 概率以**市场**为基准：幂法去水后的隐含概率，是先验，也是下限；
  2. 「数据」只做**有界修正**：近况（本库已结束比赛）与伤停各自最多挪动 λ ±12%，
     样本越多修正越大（n/(n+4)），没有样本就不修正——旧的客户端做法是拿同一份赔率
     反推 λ 再和赔率比大小，必然在拟合噪声处「发现优势」，于是挑出 22.00 的冷门；
  3. 串关有硬约束：最多 3 场、总赔率 ≤ 8、单腿融合概率 ≥ 0.44、每条腿赔率 ≤ 3.3，
     2串1 命中率必须 ≥ 26%。达不到就返回「今天没有值得推的方案」，而不是硬凑。

输出里带 coverage / filtered，UI 可以老实告诉用户「这一场为什么没被选上」。
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from itertools import combinations
from typing import Any

from .mathx import clamp, fit_lambdas, pool_probabilities, score_matrix
from .odds import POOL_LABEL, market_probabilities, option_label, read_pools

MAX_LEGS = 3
BEIJING = timezone(timedelta(hours=8))

# 前端标签页 ↔ 可推荐玩法的对应关系：
#   胜平负标签页里同时有 had 与 hhad（让球），所以这两组一起参与；
#   比分 / 半全场不参与（方差太大，回测也没有稳定优势）。
POOL_SETS = {
    "had": ("had", "hhad"),
    "hhad": ("hhad",),
    "ttg": ("ttg",),
    "mixed": ("had", "hhad", "ttg"),
}

POOL_SET_LABEL = {
    "had": "胜平负 + 让球",
    "hhad": "让球胜平负",
    "ttg": "总进球",
    "mixed": "混合玩法",
}

TIERS = {
    "safe": (
        {"marketP": 0.42, "blendP": 0.52, "minOdd": 1.25, "maxOdd": 2.15},
        {"marketP": 0.36, "blendP": 0.47, "minOdd": 1.25, "maxOdd": 2.45},
    ),
    "aggressive": (
        {"marketP": 0.3, "blendP": 0.44, "minOdd": 1.4, "maxOdd": 3.3},
        {"marketP": 0.26, "blendP": 0.4, "minOdd": 1.4, "maxOdd": 3.6},
    ),
}

PLAN_SPECS = {
    "safe": {"id": "safe", "label": "稳健 2串1", "legs": 2, "maxTotalOdd": 4.2, "minHitProb": 0.26, "objective": "hit"},
    "aggressive": {"id": "aggressive", "label": "进取 3串1", "legs": 3, "maxTotalOdd": 8.0, "minHitProb": 0.15, "objective": "ev"},
}

SINGLE_TIERS = (
    {"minBlendP": 0.5, "minOdd": 1.2, "maxOdd": 2.15},
    {"minBlendP": 0.2, "minOdd": 1.2, "maxOdd": 4.5},
)


def beijing_date(now: datetime) -> str:
    return now.astimezone(BEIJING).strftime("%Y-%m-%d")


def iso_js(value: datetime) -> str:
    """JS `toISOString()` 风格：毫秒 + Z。"""
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _js_fixed(value: float, digits: int) -> float:
    return round(value, digits)


def percent(value: float) -> str:
    return f"{value * 100:.1f}%"


def build_history_index(finished: list[dict]) -> dict[int, list[dict]]:
    index: dict[int, list[dict]] = {}

    def push(team_id: int, entry: dict) -> None:
        index.setdefault(team_id, []).append(entry)

    for match in finished:
        if match.get("homeTeamId"):
            push(
                match["homeTeamId"],
                {"kickoffAt": match["kickoffAt"], "gf": match["homeScore"], "ga": match["awayScore"], "home": True},
            )
        if match.get("awayTeamId"):
            push(
                match["awayTeamId"],
                {"kickoffAt": match["kickoffAt"], "gf": match["awayScore"], "ga": match["homeScore"], "home": False},
            )

    for entries in index.values():
        entries.sort(key=lambda entry: entry["kickoffAt"], reverse=True)
    return index


def team_form(index: dict[int, list[dict]], team_id: int | None, before: str, limit: int = 6) -> dict[str, int]:
    entries = []
    if team_id:
        entries = [entry for entry in index.get(team_id, []) if entry["kickoffAt"] < before][:limit]

    wins = draws = losses = goals_for = goals_against = 0
    home_wins = home_draws = home_losses = home_matches = 0

    for entry in entries:
        if entry["gf"] > entry["ga"]:
            wins += 1
        elif entry["gf"] == entry["ga"]:
            draws += 1
        else:
            losses += 1
        goals_for += entry["gf"]
        goals_against += entry["ga"]
        if entry["home"]:
            home_matches += 1
            if entry["gf"] > entry["ga"]:
                home_wins += 1
            elif entry["gf"] == entry["ga"]:
                home_draws += 1
            else:
                home_losses += 1

    return {
        "n": len(entries),
        "wins": wins,
        "draws": draws,
        "losses": losses,
        "goalsFor": goals_for,
        "goalsAgainst": goals_against,
        "points": wins * 3 + draws,
        "homeMatches": home_matches,
        "homeWins": home_wins,
        "homeDraws": home_draws,
        "homeLosses": home_losses,
    }


def form_adjustment(home_form: dict, away_form: dict) -> dict[str, float]:
    """近况修正：有界（±12%），样本越多越敢动；没有样本就完全不动。"""
    sample = min(home_form["n"], away_form["n"])
    if sample == 0:
        return {"home": 1.0, "away": 1.0, "sample": 0}

    def strength(form: dict) -> float:
        return form["points"] / (3 * form["n"])

    diff = strength(home_form) - strength(away_form)
    damp = sample / (sample + 4)
    delta = clamp(0.35 * diff * damp, -0.12, 0.12)
    return {"home": 1 + delta, "away": 1 - delta, "sample": sample}


def injury_adjustment(injury: dict | None) -> float:
    """伤停修正：每缺 1 人 −3%，最多 −12%（只动自己的进攻 λ）。"""
    count = (injury or {}).get("count", 0) or 0
    return 1 - 0.03 * min(count, 4)


def plan_note(spec: dict, hit_prob: float, expected_return: float) -> str:
    expectation = (
        "融合概率下的期望回报略高于 1，仍不代表稳赢。"
        if expected_return >= 1
        else f"融合概率下的期望回报 {expected_return:.2f}×（庄家抽水仍在），只作概率参考。"
    )
    return f"{spec['legs']} 场串关，融合命中率 {percent(hit_prob)}。{expectation}"


def best_combo(candidates: list[dict], spec: dict, objective: str) -> dict | None:
    pool = candidates[:12]
    best: dict | None = None

    for legs in combinations(pool, spec["legs"]):
        total_odd = 1.0
        hit_prob = 1.0
        for leg in legs:
            total_odd *= leg["odd"]
            hit_prob *= leg["blendP"]
        if total_odd > spec["maxTotalOdd"] or hit_prob < spec["minHitProb"]:
            continue
        # 同联赛的腿略微降权：同轮同联赛的赛果相关性高，串在一起并没有降低风险
        leagues = {leg["league"] for leg in legs}
        diversity_penalty = 0.0 if len(leagues) == len(legs) else 0.02
        if objective == "hit":
            value = hit_prob - diversity_penalty
        else:
            value = hit_prob * total_odd - 0.35 * max(0.0, total_odd - 4) - diversity_penalty
        if best is None or value > best["value"]:
            best = {"legs": list(legs), "totalOdd": total_odd, "hitProb": hit_prob, "value": value}

    return best


def pick_tier(candidates: list[dict], tiers: tuple[dict, ...], spec: dict) -> dict | None:
    for tier in tiers:
        eligible = [
            item
            for item in candidates
            if item["marketP"] >= tier["marketP"]
            and item["blendP"] >= tier["blendP"]
            and item["odd"] >= tier["minOdd"]
            and item["odd"] <= tier["maxOdd"]
        ]
        if len(eligible) >= spec["legs"]:
            combo = best_combo(eligible, spec, spec["objective"])
            if combo:
                return {**combo, "tier": tier}
    return None


def describe_leg(leg: dict, injury: dict | None, home_form: dict, away_form: dict) -> list[str]:
    reasons: list[str] = []

    def form_text(form: dict, place: str) -> str:
        if form["n"] <= 0:
            return ""
        return (
            f"{place}近 {form['n']} 场 {form['wins']}胜{form['draws']}平{form['losses']}负"
            f"（场均进 {form['goalsFor'] / form['n']:.1f} 失 {form['goalsAgainst'] / form['n']:.1f}）"
        )

    if leg["pool"] == "ttg":
        parts = [form_text(home_form, "主队"), form_text(away_form, "客队")]
        parts = [part for part in parts if part]
        reasons.append("；".join(parts) if parts else "本库没有这两队的近期战绩，概率只按市场与伤停估")
    else:
        is_home = leg["side"] != "away"
        form = home_form if is_home else away_form
        if form["n"] > 0:
            venue = (
                f"，同侧近 {form['homeMatches']} 场 {form['homeWins']}胜{form['homeDraws']}平{form['homeLosses']}负"
                if form["homeMatches"] > 0
                else ""
            )
            reasons.append(f"{form_text(form, '主队' if is_home else '客队')}{venue}")
        else:
            reasons.append("本库没有这队的近期战绩，概率只按市场与伤停估")

    sides = ("home", "away") if leg["pool"] == "ttg" else (("away",) if leg["side"] == "away" else ("home",))
    for side in sides:
        injury_side = (injury or {}).get(side)
        if injury_side and injury_side.get("count", 0) > 0:
            names = "、".join(injury_side.get("names", [])[:2])
            name_text = f"（{names}）" if names else ""
            reasons.append(
                f"{'主队' if side == 'home' else '客队'}伤停 {injury_side['count']} 人{name_text}，"
                f"λ 下调 {min(injury_side['count'], 4) * 3:.0f}%"
            )

    edge_pct = f"{leg['edge'] * 100:.1f}"
    sign = "+" if leg["edge"] >= 0 else ""
    reasons.append(
        f"市场 {percent(leg['marketP'])} → 模型 {percent(leg['modelP'])} → 融合 {percent(leg['blendP'])}"
        f"（{sign}{edge_pct} 个百分点）"
    )
    return reasons


def build_recommendation(
    *,
    slate: list[dict],
    injuries: dict[int, dict] | None = None,
    finished: list[dict] | None = None,
    pool: str = "mixed",
    scope: str = "today",
    now: datetime | None = None,
) -> dict[str, Any]:
    injuries = injuries or {}
    finished = finished or []
    now = now or datetime.now(timezone.utc)

    today = beijing_date(now)
    allowed = POOL_SETS.get(pool, ())
    history_index = build_history_index(finished)

    in_scope = [match for match in slate if (match["businessDate"] == today if scope == "today" else True)]
    coverage = {
        "onSale": len(slate),
        "inScope": len(in_scope),
        "withOdds": 0,
        "withInjury": 0,
        "withHistory": 0,
        "historyMatches": len(finished),
        "today": today,
    }
    filtered = {
        "noOdds": 0,
        "noMarket": 0,
        "noCandidate": 0,
        "probTooLow": 0,
        "oddsOutOfBand": 0,
        "invalidPool": len(allowed) == 0,
    }

    candidates: list[dict] = []

    for match in in_scope:
        if not match.get("odds"):
            filtered["noOdds"] += 1
            continue
        coverage["withOdds"] += 1

        pools = read_pools(match["odds"])
        market = market_probabilities(pools)
        injury = injuries.get(match["matchId"])
        if injury:
            coverage["withInjury"] += 1

        before = match.get("kickoffAt") or iso_js(now)
        home_form = team_form(history_index, match.get("homeTeamId"), before)
        away_form = team_form(history_index, match.get("awayTeamId"), before)
        if home_form["n"] > 0 and away_form["n"] > 0:
            coverage["withHistory"] += 1

        fit = fit_lambdas(market["had"], market["ttg"], pools["hhadLine"])
        if not fit:
            filtered["noMarket"] += 1
            continue

        form = form_adjustment(home_form, away_form)
        injury_home = injury_adjustment((injury or {}).get("home"))
        injury_away = injury_adjustment((injury or {}).get("away"))
        home_scale = clamp(form["home"] * injury_home, 0.75, 1.3)
        away_scale = clamp(form["away"] * injury_away, 0.75, 1.3)

        model = pool_probabilities(
            score_matrix(fit["home"] * home_scale, fit["away"] * away_scale),
            pools["hhadLine"],
        )

        # 融合权重：市场为主导，数据样本越多、伤停越确定，模型权重越大（上限 0.42）
        sample = min(home_form["n"], away_form["n"])
        weight = 0.06 * sample
        if injury:
            weight += 0.04
        weight = clamp(weight, 0.02, 0.42)

        match_candidates: list[dict] = []
        for pool_key in allowed:
            market_pool = market.get(pool_key)
            model_pool = model.get(pool_key)
            if not market_pool or not model_pool:
                continue
            odds_pool = pools[pool_key]
            for key, market_p in market_pool.items():
                odd = odds_pool.get(key, 0.0)
                model_p = model_pool.get(key, 0.0)
                if not odd or not market_p or not model_p:
                    continue
                blend_p = weight * model_p + (1 - weight) * market_p
                edge = blend_p * odd - 1
                confidence = "high" if blend_p >= 0.6 and market_p >= 0.55 else "medium" if blend_p >= 0.5 else "low"
                match_candidates.append(
                    {
                        "matchId": match["matchId"],
                        "matchNo": match["matchNo"],
                        "league": match["league"],
                        "teams": f"{match['homeName']} vs {match['awayName']}",
                        "kickoffAt": match.get("kickoffAt"),
                        "pool": pool_key,
                        "poolLabel": POOL_LABEL[pool_key],
                        "optionKey": f"rq-{key}" if pool_key == "hhad" else key,
                        "optionLabel": option_label(pool_key, key, pools["hhadLine"]),
                        "side": "away" if key == "a" else "home",
                        "odd": odd,
                        "marketP": market_p,
                        "modelP": model_p,
                        "blendP": blend_p,
                        "edge": edge,
                        "confidence": confidence,
                        "weight": weight,
                        "goalLine": pools["hhadLine"],
                        "lambda": {"home": fit["home"] * home_scale, "away": fit["away"] * away_scale},
                        "sample": {
                            "homeMatches": home_form["n"],
                            "awayMatches": away_form["n"],
                            "injuriesHome": (injury or {}).get("home", {}).get("count", 0),
                            "injuriesAway": (injury or {}).get("away", {}).get("count", 0),
                        },
                    }
                )

        if not match_candidates:
            filtered["noMarket"] += 1
            continue

        match_candidates.sort(key=lambda item: item["blendP"], reverse=True)
        best = match_candidates[0]
        safe_tier = TIERS["safe"][0]
        aggressive_tier = TIERS["aggressive"][0]

        reject_reason = ""
        if best["marketP"] < aggressive_tier["marketP"]:
            reject_reason = f"市场概率 {percent(best['marketP'])} 太低，不推"
            filtered["probTooLow"] += 1
        elif best["odd"] > aggressive_tier["maxOdd"]:
            reject_reason = f"最可能选项赔率 {best['odd']:.2f} 仍偏高（>{aggressive_tier['maxOdd']}），不推"
            filtered["oddsOutOfBand"] += 1

        pass_safe = (
            best["marketP"] >= safe_tier["marketP"]
            and best["blendP"] >= safe_tier["blendP"]
            and best["odd"] >= safe_tier["minOdd"]
            and best["odd"] <= safe_tier["maxOdd"]
        )
        pass_aggressive = (
            best["marketP"] >= aggressive_tier["marketP"]
            and best["blendP"] >= aggressive_tier["blendP"]
            and best["odd"] >= aggressive_tier["minOdd"]
            and best["odd"] <= aggressive_tier["maxOdd"]
        )

        if not pass_safe and not pass_aggressive:
            filtered["noCandidate"] += 1
            if not reject_reason:
                reject_reason = f"融合概率 {percent(best['blendP'])} / 赔率 {best['odd']:.2f} 未达门槛"

        candidates.append(
            {
                **best,
                "passSafe": pass_safe,
                "passAggressive": pass_aggressive,
                "rejectReason": reject_reason,
                "reasons": describe_leg(best, injury, home_form, away_form),
                "alternatives": match_candidates[1:3],
            }
        )

    plans: list[dict] = []

    # 单关：串关每多一层就多一层抽水，能推单关就先把单关摆出来。
    # 第二档是给总进球这种「单场概率上限只有 30% 左右」的玩法留的：只推一注，不串。
    for tier in SINGLE_TIERS:
        eligible = sorted(
            [
                item
                for item in candidates
                if item["blendP"] >= tier["minBlendP"] and item["odd"] >= tier["minOdd"] and item["odd"] <= tier["maxOdd"]
            ],
            key=lambda item: item["blendP"],
            reverse=True,
        )
        if not eligible:
            continue
        leg = eligible[0]
        low_probability = leg["blendP"] < 0.4
        plans.append(
            {
                "id": "single",
                "label": "单关（低概率玩法）" if low_probability else "单关首选",
                "risk": "中" if low_probability else "低",
                "legs": [leg],
                "totalOdd": _js_fixed(leg["odd"], 2),
                "hitProb": _js_fixed(leg["blendP"], 4),
                "expectedReturn": _js_fixed(leg["blendP"] * leg["odd"], 3),
                "note": (
                    f"这个玩法单场概率上限就低（{percent(leg['blendP'])}），只给单关参考，不串关。"
                    if low_probability
                    else f"单场命中率 {percent(leg['blendP'])}。串关每多一层就多一层抽水，只想跟一场时优先看这个。"
                ),
            }
        )
        break

    for kind in ("safe", "aggressive"):
        spec = PLAN_SPECS[kind]
        tiers = TIERS[kind]
        eligible = [item for item in candidates if (item["passSafe"] if kind == "safe" else item["passAggressive"])]
        combo = pick_tier(eligible, tiers, spec) if len(eligible) >= spec["legs"] else None
        if not combo:
            continue
        legs = [{**leg, "reasons": leg["reasons"]} for leg in combo["legs"]]
        plans.append(
            {
                "id": spec["id"],
                "label": spec["label"],
                "risk": "低" if kind == "safe" else "中",
                "legs": legs,
                "totalOdd": _js_fixed(combo["totalOdd"], 2),
                "hitProb": _js_fixed(combo["hitProb"], 4),
                "expectedReturn": _js_fixed(combo["hitProb"] * combo["totalOdd"], 3),
                "note": plan_note(spec, combo["hitProb"], combo["hitProb"] * combo["totalOdd"]),
            }
        )

    notes: list[str] = []
    if len(allowed) == 0:
        notes.append("比分 / 半全场方差太大，不进入推荐；可切到胜平负、让球或总进球再试。")
    if coverage["historyMatches"] < 30:
        notes.append("本库复盘样本只有几十场，模型只做轻量修正，概率以市场为基准。")
    if coverage["withInjury"] == 0:
        notes.append("这一批赛事还没有抓到伤停数据，修正项按 0 处理。")
    if len(allowed) == 1 and allowed[0] == "ttg":
        notes.append("总进球单场概率上限通常只有 25–35%，这里只给单关参考，不做串关。")
    if not plans:
        notes.append("今天没有达到门槛的方案：宁可空着，也不硬凑高赔长串。")

    candidates.sort(key=lambda item: item["blendP"], reverse=True)
    exposed_candidates = [
        {
            "matchId": item["matchId"],
            "matchNo": item["matchNo"],
            "league": item["league"],
            "teams": item["teams"],
            "kickoffAt": item["kickoffAt"],
            "pool": item["pool"],
            "optionKey": item["optionKey"],
            "optionLabel": item["optionLabel"],
            "odd": item["odd"],
            "marketP": item["marketP"],
            "modelP": item["modelP"],
            "blendP": item["blendP"],
            "edge": item["edge"],
            "weight": item["weight"],
            "confidence": item["confidence"],
            "passSafe": item["passSafe"],
            "passAggressive": item["passAggressive"],
            "rejectReason": item["rejectReason"],
            "reasons": item["reasons"],
        }
        for item in candidates[:12]
    ]

    return {
        "generatedAt": iso_js(now),
        "scope": scope,
        "pool": pool,
        "poolLabel": POOL_SET_LABEL.get(pool, pool),
        "coverage": coverage,
        "filtered": filtered,
        "plans": plans,
        "candidates": exposed_candidates,
        "analyzed": len(candidates),
        "notes": notes,
    }
