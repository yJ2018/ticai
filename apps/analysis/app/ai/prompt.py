"""单场分析提示词构建（纯函数，逐字节对齐 apps/api/src/ai/prompt.mjs）。

设计目标：
1. 客户端只传 matchId + pool，提示词版本随服务端发布，不再受前端缓存影响；
2. 同样的输入产出**逐字节相同**的 system 段，方便命中 DeepSeek 上下文缓存；
3. 严格控制长度：官方数据只保留有预测价值的字段，缺失的直接不写。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

POOL_KEYS = ["had", "crs", "ttg", "hafu", "mixed"]

POOL_LABELS = {
    "had": "胜平负",
    "crs": "比分",
    "ttg": "总进球数",
    "hafu": "半全场",
    "mixed": "混合过关",
}

POOL_FOCUS = {
    "had": "重点给出胜/平/负推荐，并结合让球盘口说明是否值得考虑让球选项",
    "crs": "重点给出最可能的 2-3 个比分，按概率从高到低排列",
    "ttg": "重点给出总进球数区间（0-1 球 / 2-3 球 / 4 球以上），并给出最可能的具体进球数",
    "hafu": "重点给出半全场组合推荐，并说明对上半场走势的判断",
    "mixed": "从胜平负、总进球、比分、半全场中挑出 1-2 个最有价值的选项，不要面面俱到",
}

SYSTEM_PROMPT = """你是一名资深足球比赛分析师，服务中国竞彩用户。
你会收到：比赛信息、当前玩法、该玩法赔率、体彩官方数据（伤停/交锋/近况/排名，可能部分缺失）、比赛地天气（可能缺失）。

要求：
1. 状态与战术：只依据给出的近期战绩与交锋，不臆测未提供的信息；
2. 伤停：只用给出的名单，没有就写「暂无可靠伤停信息」，严禁编造球员姓名或伤情；
3. 主客场与赛程密度；
4. 天气：有就分析对节奏的影响，没有就说明缺失；
5. 赔率：结合当前玩法解读市场倾向，不声称有内幕消息；
6. 官方数据优先，缺失项直接说明，不要用常识补全。

输出格式（严格遵守，不要 Markdown 表格、不要输出 JSON）：
【分析】
1. 状态与风格：...
2. 伤停：...
3. 主客场与赛程：...
4. 天气影响：...
5. 赔率解读：...
【预测】
推荐选项：...
比分参考：...
信心等级：高/中/低
理由：一句话总结
以上为 AI 分析，仅供参考，不构成投注建议。

中文，600-800 字，结论明确，不要模棱两可。"""

HAD_KEYS = [("h", "胜"), ("d", "平"), ("a", "负")]

TTG_KEYS = [
    ("s0", "0球"),
    ("s1", "1球"),
    ("s2", "2球"),
    ("s3", "3球"),
    ("s4", "4球"),
    ("s5", "5球"),
    ("s6", "6球"),
    ("s7", "7+"),
]

HAFU_KEYS = [
    ("hh", "胜胜"),
    ("hd", "胜平"),
    ("ha", "胜负"),
    ("dh", "平胜"),
    ("dd", "平平"),
    ("da", "平负"),
    ("ah", "负胜"),
    ("ad", "负平"),
    ("aa", "负负"),
]

# 比分只取最常见的 9 个具体比分 + 3 个「其它」，31 个全发太费 token。
CRS_KEYS = [
    ("s01s00", "1:0"),
    ("s02s00", "2:0"),
    ("s02s01", "2:1"),
    ("s00s00", "0:0"),
    ("s01s01", "1:1"),
    ("s02s02", "2:2"),
    ("s00s01", "0:1"),
    ("s00s02", "0:2"),
    ("s01s02", "1:2"),
    ("s1sh", "胜其它"),
    ("s1sd", "平其它"),
    ("s1sa", "负其它"),
]

STATUS_LABELS = {
    "scheduled": "未开赛",
    "live": "进行中",
    "finished": "已结束",
    "cancelled": "已取消",
}

BEIJING = timezone(timedelta(hours=8))


def js_num(value: Any) -> str:
    """模仿 JS 模板字符串里的 number：12.0 → "12"，10.9 → "10.9"。"""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else repr(value)
    return str(value)


def text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if value is None:
        return ""
    return js_num(value)


def pair_text(record: Any, keys: list[tuple[str, str]]) -> str:
    parts = []
    record = record if isinstance(record, dict) else {}
    for key, label in keys:
        value = text(record.get(key))
        if value:
            parts.append(f"{label}{value}")
    return " ".join(parts)


def _parse_iso(iso: Any) -> datetime | None:
    if not iso:
        return None
    raw = str(iso).strip()
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def beijing_time(iso: Any) -> str:
    """北京时间 MM-DD HH:mm。"""
    moment = _parse_iso(iso)
    if moment is None:
        return ""
    return moment.astimezone(BEIJING).strftime("%m-%d %H:%M")


def format_odds(odds: Any, pool: str) -> str:
    if not isinstance(odds, dict):
        return ""

    sections: list[str] = []

    def push(label: str, body: str) -> None:
        if body:
            sections.append(f"{label} {body}")

    wants_had = pool in ("had", "mixed")
    wants_ttg = pool in ("ttg", "mixed")
    wants_hafu = pool in ("hafu", "mixed")
    wants_crs = pool == "crs"

    if wants_had:
        push("胜平负", pair_text(odds.get("had"), HAD_KEYS))
        hhad = odds.get("hhad") if isinstance(odds.get("hhad"), dict) else {}
        goal_line = text(hhad.get("goalLine") if hhad.get("goalLine") is not None else hhad.get("goalLineValue"))
        push(f"让球({goal_line})" if goal_line else "让球", pair_text(hhad, HAD_KEYS))
    if wants_ttg:
        push("总进球", pair_text(odds.get("ttg"), TTG_KEYS))
    if wants_hafu:
        push("半全场", pair_text(odds.get("hafu"), HAFU_KEYS))
    if wants_crs:
        push("比分", pair_text(odds.get("crs"), CRS_KEYS))

    return "；".join(sections)


def format_score(value: Any) -> str:
    raw = text(value)
    parts = raw.split(":")
    if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
        return raw
    return ""


def format_h2h(feeds: dict) -> str:
    history = feeds.get("history") if isinstance(feeds, dict) else None
    history = history if isinstance(history, dict) else {}
    feed_list = history.get("matchList")
    if not isinstance(feed_list, list) or not feed_list:
        return ""

    stat = history.get("statistics") if isinstance(history.get("statistics"), dict) else {}
    summary = ""
    if stat.get("totalLegCnt"):
        summary = (
            f"近{text(stat.get('totalLegCnt'))}场 胜{text(stat.get('winProbability')) or '-'} "
            f"平{text(stat.get('drawProbability')) or '-'} 负{text(stat.get('lossProbability')) or '-'}"
        )

    items = []
    for item in feed_list[:3]:
        score = format_score(item.get("fullCourtGoal"))
        date = text(item.get("matchDate"))[5:]
        if score:
            items.append(f"{date} {text(item.get('homeTeamShortName'))}{score}{text(item.get('awayTeamShortName'))}")

    return "｜".join(part for part in (summary, "、".join(items)) if part)


def format_injuries(feeds: dict, home_name: str, away_name: str) -> str:
    groups = []
    injury = feeds.get("injury") if isinstance(feeds, dict) else None
    injury = injury if isinstance(injury, dict) else {}

    for side, fallback_name in (("home", home_name), ("away", away_name)):
        block = injury.get(side)
        if not isinstance(block, dict):
            continue
        name = text(block.get("teamShortName")) or fallback_name
        people_list = block.get("injuriesAndSuspensionsList")
        people_list = people_list if isinstance(people_list, list) else []
        if not people_list:
            groups.append(f"{name}无")
            continue
        people = []
        for person in people_list[:4]:
            person = person if isinstance(person, dict) else {}
            position = text(person.get("playerPositionDesc"))
            try:
                kind = "停" if float(person.get("suspensionFlag")) == 1 else "伤"
            except (TypeError, ValueError):
                kind = "伤"
            label = f"{text(person.get('personName'))}{f'({position})' if position else ''}{kind}"
            if label.strip():
                people.append(label)
        groups.append(f"{name} {'、'.join(people)}")

    return "｜".join(groups) if groups else ""


def format_recent(feeds: dict, home_name: str, away_name: str) -> str:
    groups = []
    result = feeds.get("result") if isinstance(feeds, dict) else None
    result = result if isinstance(result, dict) else {}

    for side, name in (("home", home_name), ("away", away_name)):
        block = result.get(side) if isinstance(result.get(side), dict) else {}
        feed_list = block.get("matchList")
        if not isinstance(feed_list, list) or not feed_list:
            continue
        items = []
        for item in feed_list[:4]:
            item = item if isinstance(item, dict) else {}
            score = format_score(item.get("fullCourtGoal"))
            if not score:
                continue
            home_goals, away_goals = (int(part) for part in score.split(":"))
            tag = ""
            if item.get("homeTeamShortName") == name:
                tag = "胜" if home_goals > away_goals else "平" if home_goals == away_goals else "负"
            elif item.get("awayTeamShortName") == name:
                tag = "胜" if away_goals > home_goals else "平" if away_goals == home_goals else "负"
            items.append(f"{text(item.get('matchDate'))[5:]}{tag}{score}")
        if items:
            groups.append(f"{name} {' '.join(items)}")

    return "｜".join(groups) if groups else ""


def format_lineup(lineup: Any) -> str:
    if not isinstance(lineup, dict):
        return ""
    groups = []
    for label, block in (("主", lineup.get("home")), ("客", lineup.get("away"))):
        if not isinstance(block, dict):
            continue
        starters = block.get("starters")
        if not isinstance(starters, list) or not starters:
            continue
        formation = f"{text(block.get('formation'))} " if text(block.get("formation")) else ""
        tag = "" if block.get("confirmed") else "（预测）"
        groups.append(f"{label} {formation}{tag}{'、'.join(str(name) for name in starters)}")
    return "｜".join(groups)


def format_table(feeds: dict) -> str:
    tables = feeds.get("tables") if isinstance(feeds, dict) else None
    tables = tables if isinstance(tables, dict) else {}
    rows = tables.get("tables")
    if not isinstance(rows, list) or not rows:
        return ""
    return "｜".join(
        f"{text(row.get('teamShortName'))}第{text(row.get('ranking'))}({text(row.get('points'))}分)"
        for row in rows[:4]
        if isinstance(row, dict)
    )


def format_weather(weather: Any) -> str:
    if not isinstance(weather, dict) or weather.get("available") is False:
        return ""
    parts = []
    if weather.get("city"):
        parts.append(str(weather["city"]))
    current = weather.get("current") if isinstance(weather.get("current"), dict) else {}
    if current:
        if current.get("temperature") is not None:
            parts.append(f"{js_num(current['temperature'])}℃")
        if current.get("weather"):
            parts.append(str(current["weather"]))
        if current.get("humidity") is not None:
            parts.append(f"湿度{js_num(current['humidity'])}%")
    kickoff = weather.get("kickoff") if isinstance(weather.get("kickoff"), dict) else {}
    if kickoff.get("precipitationProbability") is not None:
        parts.append(f"开赛降水{js_num(kickoff['precipitationProbability'])}%")
    return " ".join(parts)


def weather_label(weather: Any) -> str:
    if not isinstance(weather, dict) or weather.get("available") is False:
        return "比赛地天气未获取"
    current = weather.get("current") if isinstance(weather.get("current"), dict) else {}
    temperature = f"{js_num(current['temperature'])}℃ " if current.get("temperature") is not None else ""
    return f"{weather.get('city') or ''} {temperature}{current.get('weather') or ''}".strip()


def build_analysis_prompt(
    *,
    match: dict,
    odds: Any,
    feeds: dict | None = None,
    weather: Any = None,
    pool: str = "ttg",
    lineup: Any = None,
) -> dict:
    feeds = feeds or {}
    home_name = match.get("homeName") or "主队"
    away_name = match.get("awayName") or "客队"
    kickoff = beijing_time(match.get("kickoffAt"))
    status = STATUS_LABELS.get(match.get("status") or "", "")

    match_no = f"{match['matchNo']} " if match.get("matchNo") else ""
    lines = [
        f"比赛：{match_no}{match.get('league') or '未知赛事'} {home_name} vs {away_name}"
        f"{f' {kickoff}' if kickoff else ''}{f'（{status}）' if status else ''}",
        f"玩法：{POOL_LABELS.get(pool, pool)}（{POOL_FOCUS.get(pool, '')}）",
    ]

    odds_text = format_odds(odds, pool)
    if odds_text:
        lines.append(f"赔率：{odds_text}")

    h2h = format_h2h(feeds)
    if h2h:
        lines.append(f"交锋：{h2h}")

    injuries = format_injuries(feeds, home_name, away_name)
    if injuries:
        lines.append(f"伤停：{injuries}")

    lineup_text = format_lineup(lineup)
    if lineup_text:
        lines.append(f"阵容：{lineup_text}")

    recent = format_recent(feeds, home_name, away_name)
    if recent:
        lines.append(f"近况：{recent}")

    table = format_table(feeds)
    if table:
        lines.append(f"排名：{table}")

    weather_text = format_weather(weather)
    if weather_text:
        lines.append(f"天气：{weather_text}")

    user = "\n".join(lines) + "\n\n按系统提示的格式输出分析与预测。"

    return {"system": SYSTEM_PROMPT, "user": user, "chars": len(user)}
