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


SOURCES = {
    0: [
        ("产品定义与边界", "/product/definition"),
        ("任务覆盖", "/product/task-coverage"),
        ("领域模型与协议", "/architecture/domain-model"),
        ("评估体系", "/architecture/evaluation"),
    ],
    1: [
        ("持久执行与恢复", "/architecture/durable-execution"),
        ("执行器模型", "/architecture/executor-model"),
        ("执行安全与副作用", "/architecture/execution-safety"),
        ("前端与移动体验", "/architecture/frontend-experience"),
    ],
    2: [
        ("个人网关", "/architecture/gateway"),
        ("执行器目录", "/architecture/executor-catalog"),
        ("安全与隐私", "/architecture/security-privacy"),
        ("Token 经济", "/architecture/token-economics"),
    ],
    3: [
        ("人工接管与审批", "/architecture/human-takeover"),
        ("执行安全与副作用", "/architecture/execution-safety"),
        ("执行器目录", "/architecture/executor-catalog"),
        ("前端与移动体验", "/architecture/frontend-experience"),
    ],
    4: [
        ("控制面与自主性", "/architecture/control-plane"),
        ("个人网关", "/architecture/gateway"),
        ("安全与隐私", "/architecture/security-privacy"),
        ("前端与移动体验", "/architecture/frontend-experience"),
    ],
    5: [
        ("记忆系统", "/architecture/memory"),
        ("技能进化", "/architecture/evolution"),
        ("评估体系", "/architecture/evaluation"),
        ("安全与隐私", "/architecture/security-privacy"),
    ],
    6: [
        ("总体架构与数据流", "/architecture/overview"),
        ("持久执行与恢复", "/architecture/durable-execution"),
        ("安全与隐私", "/architecture/security-privacy"),
        ("工程交付与仓库结构", "/delivery/engineering"),
    ],
}

EN_SOURCE_LABELS = {
    "/product/definition": "Product definition and boundaries",
    "/product/task-coverage": "Task coverage",
    "/architecture/domain-model": "Domain model and protocol",
    "/architecture/evaluation": "Evaluation",
    "/architecture/durable-execution": "Durable execution and recovery",
    "/architecture/executor-model": "Executor model",
    "/architecture/execution-safety": "Execution safety and effects",
    "/architecture/frontend-experience": "Frontend and mobile experience",
    "/architecture/gateway": "Personal gateway",
    "/architecture/executor-catalog": "Executor catalog",
    "/architecture/security-privacy": "Security and privacy",
    "/architecture/token-economics": "Token economics",
    "/architecture/human-takeover": "Human takeover and approval",
    "/architecture/control-plane": "Control plane and autonomy",
    "/architecture/memory": "Memory system",
    "/architecture/evolution": "Skill evolution",
    "/architecture/overview": "Architecture and data flow",
    "/delivery/engineering": "Engineering delivery and repository layout",
}


def module_headings(modules: list[list[str]]) -> list[str]:
    lines: list[str] = []
    for number, (title, detail) in enumerate(modules, 1):
        lines.extend([f"### {number:02d} · {title}", "", detail, ""])
    return lines


def source_lines(stage_no: int, lang: str) -> list[str]:
    prefix = "/en" if lang == "en" else ""
    heading = "延伸阅读" if lang == "zh" else "Source material"
    lines = [f"### {heading}", ""]
    for label, path in SOURCES[stage_no]:
        if lang == "en":
            label = EN_SOURCE_LABELS[path]
        lines.append(f"- [{label}]({prefix}{path})")
    lines.append("")
    return lines


def acceptance_steps(data: dict, index: int, lang: str) -> list[str]:
    item = data["increments"][index]
    text = item[lang]
    stage_no = data["stage"]
    modules = data["details"]["increments"][item["id"]][lang]["modules"]
    case, seen, recovery = data[lang]["failures"][0]
    package_names = ("、".join(module[0] for module in modules) if lang == "zh" else "; ".join(module[0] for module in modules))
    page = f"/delivery/stage-{stage_no}/{item['slug']}"
    prefix = "/en" if lang == "en" else ""
    if lang == "zh":
        return [
            f"从干净的数据目录启动 hearthd，打开 [{item['id']} 页面]({prefix}{page})，确认当前页面没有依赖浏览器缓存或手工种子数据。",
            f"按顺序完成四个工作包：{package_names}。每完成一个工作包，保存对应测试输出、截图或产物版本。",
            f"复现失败案例“{case}”。页面必须显示“{seen}”，然后按“{recovery}”恢复；不得出现重复副作用或未登记状态。",
            "重启服务并重新打开任务，确认运行状态、审批、产物和恢复入口都来自持久投影，而不是只存在于当前页面。",
            f"运行上方的共享验证命令并导出证据。完成门槛是：{text['gate']}",
        ]
    return [
        f"Start hearthd from a clean data directory, open the [{item['id']} page]({prefix}{page}), and confirm it relies on no browser cache or hand-seeded data.",
        f"Complete the four work packages in order: {package_names}. Preserve the matching test output, screenshot, or artifact version after each package.",
        f"Reproduce the failure case \"{case}\". The page must show \"{seen}\", then recover with \"{recovery}\"; no duplicate effect or unregistered state is allowed.",
        "Restart the service and reopen the task. Runtime state, approvals, artifacts, and recovery entry points must all come from durable projections rather than the current page.",
        f"Run the shared verification commands above and export the evidence. The completion gate is: {text['gate']}",
    ]


def render(data: dict, index: int, lang: str) -> str:
    item = data["increments"][index]
    text = item[lang]
    stage_info = data[lang]
    previous = data["increments"][index - 1] if index else None
    following = data["increments"][index + 1] if index + 1 < len(data["increments"]) else None
    total = len(data["increments"])
    stage_no = data["stage"]
    en_prefix = "/en" if lang == "en" else ""

    if lang == "zh":
        title = f"{item['id']} · {text['title']}"
        eyebrow = f"STAGE {stage_no} · {item['id']} · {index + 1} / {total}"
        description = f"Hearth {item['id']} 开发增量：{text['outcome']}"
        headings = {
            "solve": "这一步要交付什么",
            "before": "开始前",
            "packages": "四个实施工作包",
            "engineering": "工程落点",
            "paths": "主要目录与模块",
            "interfaces": "关键接口",
            "commands": "共享验证命令",
            "acceptance": "验收演练",
            "deliverables": "交付物",
            "verify": "完成判定",
            "failure": "失败与恢复",
            "scope": "本增量不包含",
            "sources": "来源与下一步",
            "next": "完成后的下一步",
        }
        labels = {
            "outcome": "用户可见结果",
            "gate": "完成门槛",
            "interface": "接口",
            "requirement": "必须保持的契约",
            "case": "情况",
            "seen": "用户看到",
            "recovery": "恢复动作",
            "size": "1 个纵向切片 · 4 个工作包",
            "prev": f"{previous['id']} 的交付物已经验收；未通过时不进入本增量。" if previous else "",
            "package_intro": "每个工作包都要产生可运行的代码、可复现的验证或明确的界面结果；只写接口或只做页面都不算完成。",
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
            "packages": "Four implementation work packages",
            "engineering": "Engineering map",
            "paths": "Primary directories and modules",
            "interfaces": "Key interfaces",
            "commands": "Shared verification commands",
            "acceptance": "Acceptance rehearsal",
            "deliverables": "Deliverables",
            "verify": "Completion decision",
            "failure": "Failure and recovery",
            "scope": "Out of scope",
            "sources": "Source material and next step",
            "next": "Next step",
        }
        labels = {
            "outcome": "User-visible outcome",
            "gate": "Completion gate",
            "interface": "Interface",
            "requirement": "Contract that must hold",
            "case": "Case",
            "seen": "User sees",
            "recovery": "Recovery",
            "size": "1 vertical increment · 4 work packages",
            "prev": f"{previous['id']} deliverables have passed review; do not enter this increment otherwise." if previous else "",
            "package_intro": "Every work package must produce runnable code, a reproducible check, or a concrete UI result; interfaces alone or pages alone do not count as complete.",
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

    engineering = data["details"]["engineering"][lang]
    modules = data["details"]["increments"][item["id"]][lang]["modules"]
    acceptance = acceptance_steps(data, index, lang)

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
        f'<p class="page-meta">STAGE {stage_no} · {item["id"]} · {labels["size"]}</p>',
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
        f"## {headings['packages']}",
        "",
        f"> {labels['package_intro']}",
        "",
        *module_headings(modules),
        f"## {headings['engineering']}",
        "",
        f"### {headings['paths']}",
        "",
        *[
            f"- `{entry.split('：', 1)[0].strip()}` — {entry.split('：', 1)[1].strip()}"
            if lang == "zh" and "：" in entry
            else f"- `{entry.split(':', 1)[0].strip()}` — {entry.split(':', 1)[1].strip()}"
            if lang == "en" and ":" in entry
            else f"- {entry}"
            for entry in engineering["paths"]
        ],
        "",
        f"### {headings['interfaces']}",
        "",
        f"| {labels['interface']} | {labels['requirement']} |",
        "| --- | --- |",
        *[f"| `{name}` | {requirement} |" for name, requirement in engineering["interfaces"]],
        "",
        f"### {headings['commands']}",
        "",
        "```bash",
        *engineering["checks"],
        "```",
        "",
        f"## {headings['acceptance']}",
        "",
        *[f"{number}. {step}" for number, step in enumerate(acceptance, 1)],
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
        f"## {headings['sources']}",
        "",
        *source_lines(stage_no, lang),
        f"### {headings['next']}",
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
        data["details"] = json.loads((DATA / f"details-s{stage}.json").read_text(encoding="utf-8"))
        expected = {item["id"] for item in data["increments"]}
        details = data["details"]["increments"]
        if set(details) != expected:
            raise SystemExit(f"details-s{stage}.json does not match increment ids")
        for increment_id, value in details.items():
            for lang in ("zh", "en"):
                modules = value[lang]["modules"]
                if len(modules) != 4 or any(len(module) != 2 for module in modules):
                    raise SystemExit(f"{increment_id} must contain exactly four two-part modules in {lang}")
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
