"""串关分析提示词（对齐 apps/api/src/ai/parlay-prompt.mjs）。

与单场分析一样：客户端只说选了哪几场、哪些选项，赔率/伤停由服务端从库里补。
单场还允许带一段「3 小时内的本地缓存分析」，直接复用，避免重复展开。
"""

from __future__ import annotations

from typing import Any

from .prompt import POOL_LABELS, format_odds, js_num, text

SYSTEM_PROMPT = """你是一名资深竞彩足球分析师，服务中国竞彩用户。用户会给你一个已经选好的串关方案，包含每一场的对阵、当前选择和市场赔率。你的任务不是泛泛预测所有比赛，而是逐场审视用户已经选中的选项，并判断这些比赛串在一起后的整体风险。

请遵守：
1. 只分析用户给出的比赛，不要新增未列出的比赛；
2. 逐场结合双方实力、近期状态、主客场、赛程与战意，判断已选选项是否成立。无法确认的伤停、首发或球员信息必须写“暂无可靠信息”，严禁编造；
3. 赔率只作为市场参考，可以解读隐含概率和热度，但不要声称有内幕消息；
4. 指出串关的关联风险、同质风险和关键短板，例如多场都押大球、都押热门、开赛时间集中等；
5. 可以给出保留、谨慎或调整方向的倾向，但不得承诺收益，不得建议加注金额；
6. 如果某场附带“本地缓存分析”，说明 3 小时内已经分析过该场，必须沿用其中的赛前判断，不要从头重复展开；把篇幅留给未缓存场次和串关整体风险；
7. 如果总场次较多，逐场分析可以更简短，但每一场都必须覆盖。

输出格式（严格遵守，不要使用 Markdown 表格、不要输出 JSON）：
【总评】
方案思路：...
整体风险：低/中/高
【逐场分析】
1. 场次与选择：...
判断：...
风险：...
建议：...
（按此格式覆盖方案里的每一场，序号与用户给出的场次序号一致）
【串关建议】
关联风险：...
关键短板：...
可调整方向：...
【结论】
综合信心：高/中/低
一句话总结：...
以上为 AI 分析，仅供参考，不构成投注建议。

要求：中文，直接围绕这个串关方案，总字数 650-950 字（5 场以上可到 1100 字），结论明确，不要模棱两可。"""

# 每场最多带几条伤停，避免 10 串时 token 爆掉
INJURY_LIMIT_PER_SIDE = 2


def format_injury_brief(feeds: dict, home_name: str, away_name: str) -> str:
    parts = []
    injury = feeds.get("injury") if isinstance(feeds, dict) else None
    injury = injury if isinstance(injury, dict) else {}

    for side, name in (("home", home_name), ("away", away_name)):
        block = injury.get(side) if isinstance(injury.get(side), dict) else {}
        people_list = block.get("injuriesAndSuspensionsList")
        people_list = people_list if isinstance(people_list, list) else []
        if not people_list:
            continue
        people = []
        for person in people_list[:INJURY_LIMIT_PER_SIDE]:
            person = person if isinstance(person, dict) else {}
            try:
                kind = "停" if float(person.get("suspensionFlag")) == 1 else "伤"
            except (TypeError, ValueError):
                kind = "伤"
            label = f"{text(person.get('personName'))}{kind}"
            if label.strip():
                people.append(label)
        if people:
            parts.append(f"{name} {'、'.join(people)}")

    return "｜".join(parts)


def format_leg(leg: dict) -> str:
    lines = [
        f"第{js_num(leg.get('order'))}场｜{leg.get('matchNo') or ''} {leg.get('teams') or ''}",
        f"联赛与开赛：{leg.get('league') or ''}｜{leg.get('kickoff') or ''}",
        f"当前选择：{leg.get('selected') or '未选择'}",
    ]
    if leg.get("odds"):
        lines.append(f"市场赔率：{leg['odds']}")
    if leg.get("injuries"):
        lines.append(f"伤停：{leg['injuries']}")
    if leg.get("cachedAnalysis"):
        lines.append(f"本地缓存分析（3 小时内，可直接复用，不要重复分析）：{leg['cachedAnalysis']}")
    return "\n".join(lines)


def build_parlay_prompt(*, pool: str, pass_summary_text: str, bet_amount: float, max_bonus: float, legs: list[dict]) -> dict:
    header = [
        f"方案概况：{pass_summary_text or '未选择过关方式'}，共 {js_num(len(legs))} 场，"
        f"投注金额 {js_num(bet_amount)} 元，理论最高奖金 {js_num(max_bonus)} 元。",
        f"当前玩法：{POOL_LABELS.get(pool, pool)}。",
    ]

    blocks = [format_leg(leg) for leg in legs]

    user = "\n".join(
        [
            *header,
            "",
            *blocks,
            "",
            "请只基于以上已选比赛逐场分析，并评估这个串关方案的整体风险。",
        ]
    )

    return {"system": SYSTEM_PROMPT, "user": user, "chars": len(user)}


def describe_leg_odds(odds: Any, pool: str) -> str:
    return format_odds(odds, pool)
