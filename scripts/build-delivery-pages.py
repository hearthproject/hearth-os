#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "scripts" / "delivery-data"
DOCS = ROOT / "docs"

STAGE_PATHS = {
    0: "/delivery/stage-0",
    1: "/delivery/stage-1",
    2: "/delivery/stage-2",
    3: "/delivery/stage-3",
    4: "/delivery/stage-4",
    5: "/delivery/stage-5",
    6: "/delivery/stage-6",
}

WHY = {
    0: (
        "Stage 0 的产出是产品真相与实现契约。没有真实任务、可点击原型和可重复评测，后续开发会把假设当成事实。",
        "Stage 0 produces product truth and implementation contracts. Without real tasks, a clickable prototype, and repeatable evaluation, later work mistakes assumptions for facts.",
    ),
    1: (
        "Stage 1 的顺序是先有真实短闭环，再有安全副作用，最后扩大任务族和恢复覆盖；不能在空内核上先堆模块。",
        "Stage 1 delivers a real narrow loop first, safe side effects second, and broader task families and recovery last; do not stack modules on an empty kernel.",
    ),
    2: (
        "Stage 2 从只读能力逐步走向真实写入。每增加一种权限，都先证明来源、撤销、审批和回执仍然成立。",
        "Stage 2 moves from read-only access toward real writes. Every new authority must first prove provenance, revocation, approval, and receipts still hold.",
    ),
    3: (
        "Stage 3 的顺序是观察、接管、低风险动作、高风险动作；无法观察和接管的桌面自动化不具备产品资格。",
        "Stage 3 follows observation, takeover, low-risk action, and high-risk action; desktop automation that cannot be observed or taken over is not product-ready.",
    ),
    4: (
        "Stage 4 的价值不是后台运行，而是在正确的时间以可接受的打扰做正确的事。主动性必须建立在既有恢复与审批之上。",
        "Stage 4 is not about background uptime but doing the right thing at the right time with acceptable interruption, built on existing recovery and approval.",
    ),
    5: (
        "Stage 5 先让记忆可纠正、可遗忘，再让技能可评估、可回滚；任何不能解释来源和权限的变化都不能进入生产。",
        "Stage 5 makes memory correctable and forgettable before making skills evaluable and rollbackable; no unexplained provenance or authority change reaches production.",
    ),
    6: (
        "Stage 6 把单机产品变成长期驻留、可迁移、可撤销的个人 Agent OS；多设备是同一逻辑身份的能力扩展，不是复制多个 Agent。",
        "Stage 6 turns a single-device product into a long-running, portable, revocable personal Agent OS; multi-device extends one logical identity rather than cloning agents.",
    ),
}

ZH_VERIFY_EXTRA = [
    "交付物已经和契约、任务卡投影保持一致，没有未登记的字段或状态。",
    "至少一个失败路径有可操作恢复，关键动作留下审计事件。",
    "演示不依赖手工修改数据库、只在终端拼接命令，或永久 mock。",
]

EN_VERIFY_EXTRA = [
    "Deliverables match the contracts and task-card projection with no unregistered field or state.",
    "At least one failure path has an actionable recovery, and key actions leave audit events.",
    "The demo needs no manual database edit, terminal-only stitching, or permanent mock.",
]


def render(data: dict, index: int, lang: str) -> str:
    item = data["increments"][index]
    text = item[lang]
    stage_info = data[lang]
    previous = data["increments"][index - 1] if index else None
    following = data["increments"][index + 1] if index + 1 < len(data["increments"]) else None
    total = len(data["increments"])
    stage_no = data["stage"]
    detail_path = f"/delivery/stage-{stage_no}/{item['slug']}"
    en_prefix = "/en" if lang == "en" else ""

    if lang == "zh":
        title = f"{item['id']} · {text['title']}"
        eyebrow = f"STAGE {stage_no} · {item['id']} · {index + 1} / {total}"
        description = f"Hearth {item['id']} 开发增量：{text['outcome']}"
        headings = {
            "solve": "这一增量解决什么",
            "before": "开始前",
            "steps": "实施步骤",
            "contracts": "数据与接口契约",
            "deliverables": "交付物",
            "verify": "验证清单",
            "failure": "失败与恢复",
            "scope": "本增量不包含",
            "next": "完成后的下一步",
        }
        labels = {
            "outcome": "用户可见结果",
            "gate": "完成门槛",
            "checkpoint": "检查点",
            "requirement": "必须满足",
            "case": "情况",
            "seen": "用户看到",
            "recovery": "恢复动作",
            "prev": f"{previous['id']} 的交付物已经验收；未通过时不进入本增量。" if previous else "",
        }
        verify_extra = ZH_VERIFY_EXTRA
        if following:
            next_text = f"继续 [{following['id']} · {following['zh']['title']}]({en_prefix}/delivery/stage-{stage_no}/{following['slug']})。先完成本增量验收，不要用后续工作掩盖当前缺口。"
        else:
            stage_title = data["zh_title"]
            next_stage = STAGE_PATHS.get(stage_no + 1)
            if next_stage:
                next_text = f"返回 [Stage {stage_no} · {stage_title}]({en_prefix}{STAGE_PATHS[stage_no]})，确认全部退出条件后进入 [Stage {stage_no + 1}]({en_prefix}{next_stage})。"
            else:
                next_text = f"返回 [Stage {stage_no} · {stage_title}]({en_prefix}{STAGE_PATHS[stage_no]})，完成最终审计后进入长期维护与扩展阶段。"
    else:
        title = f"{item['id']} · {text['title']}"
        eyebrow = f"STAGE {stage_no} · {item['id']} · {index + 1} / {total}"
        description = f"Hearth {item['id']} development increment: {text['outcome']}"
        headings = {
            "solve": "What this increment solves",
            "before": "Before you start",
            "steps": "Implementation steps",
            "contracts": "Data and interface contracts",
            "deliverables": "Deliverables",
            "verify": "Verification checklist",
            "failure": "Failure and recovery",
            "scope": "Out of scope",
            "next": "Next step",
        }
        labels = {
            "outcome": "User-visible outcome",
            "gate": "Completion gate",
            "checkpoint": "Checkpoint",
            "requirement": "Must hold",
            "case": "Case",
            "seen": "User sees",
            "recovery": "Recovery",
            "prev": f"{previous['id']} deliverables have passed review; do not enter this increment otherwise." if previous else "",
        }
        verify_extra = EN_VERIFY_EXTRA
        if following:
            next_text = f"Continue to [{following['id']} · {following['en']['title']}]({en_prefix}/delivery/stage-{stage_no}/{following['slug']}). Finish this increment's acceptance first; do not hide gaps with later work."
        else:
            stage_title = data["en_title"]
            next_stage = STAGE_PATHS.get(stage_no + 1)
            if next_stage:
                next_text = f"Return to [Stage {stage_no} · {stage_title}]({en_prefix}{STAGE_PATHS[stage_no]}), confirm every exit condition, then enter [Stage {stage_no + 1}]({en_prefix}{next_stage})."
            else:
                next_text = f"Return to [Stage {stage_no} · {stage_title}]({en_prefix}{STAGE_PATHS[stage_no]}), complete the final audit, and move into long-term maintenance and expansion."

    prerequisites = list(stage_info["prereq"])
    if labels["prev"]:
        prerequisites.append(labels["prev"])

    lines = [
        "---",
        f"title: {json.dumps(title, ensure_ascii=False)}",
        f"description: {json.dumps(description, ensure_ascii=False)}",
        "outline: [2, 3]",
        "---",
        "",
        f'<p class="eyebrow">{eyebrow}</p>',
        "",
        f"# {title}",
        "",
        f'<p class="lead">{text["lead"]}</p>',
        "",
        '<div class="section-grid">',
        f'<div><strong>{labels["outcome"]}</strong>{text["outcome"]}</div>',
        f'<div><strong>{labels["gate"]}</strong>{text["gate"]}</div>',
        "</div>",
        "",
        f"## {headings['solve']}",
        "",
        text["outcome"],
        "",
        WHY[stage_no][0 if lang == "zh" else 1],
        "",
        f"## {headings['before']}",
        "",
        *[f"- {item}" for item in prerequisites],
        "",
        f"## {headings['steps']}",
        "",
        *[f"{n}. {step}" for n, step in enumerate(text["steps"], 1)],
        "",
        f"## {headings['contracts']}",
        "",
        f"| {labels['checkpoint']} | {labels['requirement']} |",
        "| --- | --- |",
        *[f"| {name} | {requirement} |" for name, requirement in stage_info["contracts"]],
        "",
        f"## {headings['deliverables']}",
        "",
        *[f"- {entry}" for entry in text["evidence"]],
        "",
        f"## {headings['verify']}",
        "",
        f"- [ ] {text['gate']}",
        *[f"- [ ] {entry}" for entry in verify_extra],
        "",
        f"## {headings['failure']}",
        "",
        f"| {labels['case']} | {labels['seen']} | {labels['recovery']} |",
        "| --- | --- | --- |",
        *[f"| {case} | {seen} | {recovery} |" for case, seen, recovery in stage_info["failures"]],
        "",
        f"## {headings['scope']}",
        "",
        *[f"- {entry}" for entry in stage_info["exclusions"]],
        "",
        f"## {headings['next']}",
        "",
        next_text,
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    zh_groups = []
    en_groups = []
    for stage in range(7):
        data = json.loads((DATA / f"s{stage}.json").read_text(encoding="utf-8"))
        zh_groups.append(
            {
                "text": f"S{stage} · {data['zh_title']}",
                "collapsed": True,
                "items": [
                    {"text": "模块总览", "link": f"/delivery/stage-{stage}"},
                    *[
                        {
                            "text": f"{item['id']} {item['zh']['title']}",
                            "link": f"/delivery/stage-{stage}/{item['slug']}",
                        }
                        for item in data["increments"]
                    ],
                ],
            }
        )
        en_groups.append(
            {
                "text": f"S{stage} · {data['en_title']}",
                "collapsed": True,
                "items": [
                    {"text": "Module overview", "link": f"/en/delivery/stage-{stage}"},
                    *[
                        {
                            "text": f"{item['id']} {item['en']['title']}",
                            "link": f"/en/delivery/stage-{stage}/{item['slug']}",
                        }
                        for item in data["increments"]
                    ],
                ],
            }
        )
        for lang, prefix in (("zh", ""), ("en", "en")):
            out_dir = DOCS / prefix / "delivery" / f"stage-{stage}"
            out_dir.mkdir(parents=True, exist_ok=True)
            for index, item in enumerate(data["increments"]):
                path = out_dir / f"{item['slug']}.md"
                path.write_text(render(data, index, lang), encoding="utf-8")
                print(path.relative_to(ROOT))

    sidebar = ROOT / "docs" / ".vitepress" / "delivery-sidebar.mjs"
    sidebar.write_text(
        "export const zhDeliveryStages = "
        + json.dumps(zh_groups, ensure_ascii=False, indent=2)
        + "\n\nexport const enDeliveryStages = "
        + json.dumps(en_groups, ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )
    print(sidebar.relative_to(ROOT))


if __name__ == "__main__":
    main()
