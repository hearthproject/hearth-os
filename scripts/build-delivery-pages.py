from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"

CN_NUMBERS = ["一", "二", "三", "四", "五", "六"]


PHASES = [
    {
        "num": 1,
        "slug": "stage-1",
        "zh_title": "最小完整 MVP",
        "en_title": "Minimum Complete MVP",
        "zh_summary": "交付一个可以每天使用的最小完整产品。",
        "en_summary": "Deliver the smallest complete product that a user can use every day.",
        "zh_outcome": "一个能每天使用的本地任务工作台",
        "en_outcome": "A local task workbench that can be used every day",
        "zh_goal": """第一阶段交付一个可以在真实浏览器里每天使用的最小完整产品。它只服务一个窄任务族，但必须走完“创建任务—执行—审批—查看产物—失败恢复”的完整路径。这个阶段不追求覆盖所有工作，只追求让第一条真实链路可靠可用。""",
        "en_goal": """Phase 1 delivers the smallest complete product that a real user can use every day in a browser. It serves one narrow task family, but it must cover the full path from creating a task through execution, approval, artifact review, and failure recovery. The goal is not broad coverage; it is making the first real path reliable.""",
        "zh_how": [
            "先选定首个用户和首个任务族，并用真实任务确定验收标准。",
            "用可点击原型把完整路径和所有关键状态走一遍。",
            "打通真实任务闭环，包括执行、审批、产物和失败恢复。",
            "让首位用户连续使用一周，用真实任务验收 MVP。",
        ],
        "en_how": [
            "Choose the first user and the first task family, then define acceptance with real tasks.",
            "Walk the full path and every important state through a clickable prototype.",
            "Complete the real task loop: execution, approval, artifacts, and failure recovery.",
            "Have the first user use it for a week and accept the MVP with real tasks.",
        ],
        "modules": [
            {
                "num": "1.1",
                "slug": "1-1",
                "zh_title": "明确首个场景与真实任务",
                "en_title": "Define the first scenario and real tasks",
                "zh_summary": "确定首个用户、任务族、非目标和验收任务。",
                "en_summary": "Define the first user, task family, non-goals, and acceptance tasks.",
                "zh_goal": """确定 Hearth 首先为谁解决什么问题，并把这个问题变成一组可以验收的真实任务。阶段结束时，团队应当能说清楚首个用户、首个任务族、明确不做什么，以及什么结果算完成。""",
                "en_goal": """Define who Hearth serves first and what problem it solves, then turn that problem into a set of real tasks that can be accepted. At the end of this step, the team should be able to state the first user, the first task family, what is explicitly out of scope, and what counts as done.""",
                "zh_how": [
                    "找到一位愿意提供真实任务和反馈的首位用户，记录他每天重复做、最希望交给系统的工作。",
                    "收集 20–30 个真实任务，从中选出 10–12 个输入、产物和验收方式都清楚的任务。",
                    "只选一个高频、外部风险低、结果容易检查的任务族作为首个范围。",
                    "写出一句话定位和“暂不做什么”清单，避免第一阶段被新想法带偏。",
                    "记录这些任务现在怎么做、花多少时间、哪里容易出错，作为后续对比。",
                    "确定 MVP 的验收方式：至少 8 个真实任务通过验收，失败任务能说明原因并恢复。",
                ],
                "en_how": [
                    "Find a first user who will provide real tasks and feedback, and record the repeated work they most want to hand over.",
                    "Collect 20–30 real tasks, then select 10–12 with clear inputs, outputs, and acceptance.",
                    "Choose only one frequent task family with low external risk and easy-to-check results.",
                    "Write a one-sentence position and a not-now list so the first phase is not pulled in every direction.",
                    "Record how these tasks are done today, how long they take, and where mistakes happen.",
                    "Define MVP acceptance: at least 8 real tasks pass, and failed tasks explain why and can be recovered.",
                ],
            },
            {
                "num": "1.2",
                "slug": "1-2",
                "zh_title": "做出完整体验原型",
                "en_title": "Build the complete experience prototype",
                "zh_summary": "用可点击原型走通任务、审批、产物和恢复。",
                "en_summary": "Walk through tasks, approval, artifacts, and recovery in a clickable prototype.",
                "zh_goal": """做出一个覆盖完整使用路径的可点击原型，让用户在真正开发前就能看懂产品如何工作。原型必须包含任务卡、审批、产物和失败恢复，而不是只有首页。""",
                "en_goal": """Build a clickable prototype that covers the full user path so the product can be understood before real development starts. The prototype must include task cards, approval, artifacts, and failure recovery, not just a home page.""",
                "zh_how": [
                    "设计四个主要入口：今日任务、需要你、产物、设置。",
                    "覆盖任务从创建到结束的所有关键状态：排队、执行中、等待补充信息、等待审批、已完成、失败、可恢复、已取消。",
                    "每个状态只保留一个主操作，并明确告诉用户下一步是什么。",
                    "把任务卡、审批页、产物页和失败说明做成可以点击的完整流程。",
                    "用假数据演示，但不要伪造成功；未知、失败和无法完成都要如实显示。",
                    "请首位用户在电脑和手机上各走一遍，记录卡住和看不懂的地方并修正。",
                ],
                "en_how": [
                    "Design four main entries: today, needs you, artifacts, and settings.",
                    "Cover every important task state: queued, running, waiting for information, waiting for approval, completed, failed, recoverable, and cancelled.",
                    "Keep one primary action per state and state clearly what the user should do next.",
                    "Make task cards, approval pages, artifact pages, and failure explanations click through as one complete flow.",
                    "Use sample data, but never fake success; show unknown, failed, and incomplete states honestly.",
                    "Ask the first user to walk through it on desktop and phone, then fix the confusing parts.",
                ],
            },
            {
                "num": "1.3",
                "slug": "1-3",
                "zh_title": "打通最小任务闭环",
                "en_title": "Complete the smallest real task loop",
                "zh_summary": "让任务能真实执行、审批、产出结果并在失败后恢复。",
                "en_summary": "Let a task execute, ask for approval, produce results, and recover from failure.",
                "zh_goal": """在浏览器里打通最小真实任务闭环：用户创建任务后，系统能实际完成工作、请求必要审批、交出产物，并在失败时恢复或转人工。""",
                "en_goal": """Complete the smallest real task loop in the browser: after the user creates a task, the system does real work, asks for necessary approval, delivers an artifact, and recovers or hands over when something fails.""",
                "zh_how": [
                    "做一个足够简单的本地服务和浏览器界面，先支持一个任务同时运行。",
                    "创建任务时记录目标、输入、截止时间、可用范围和允许的动作。",
                    "调用现成的执行能力在受控环境中完成真实工作，并持续显示进度。",
                    "任务状态要能跨刷新和重启保留；失败后可以重试、继续或转人工。",
                    "外部操作必须先展示对象、内容和影响，得到确认后只执行一次，并留下可核对的回执。",
                    "产物要能保存、打开和追溯来源；失败要说明原因和下一步。",
                    "限制系统可访问的文件、账户和网络范围，敏感信息不直接暴露给执行过程。",
                ],
                "en_how": [
                    "Build a simple local service and browser interface; one running task at a time is enough.",
                    "When creating a task, record the goal, inputs, deadline, available scope, and allowed actions.",
                    "Use an existing execution capability to do real work in a controlled environment and show progress continuously.",
                    "Keep task state across refresh and restart; after failure, allow retry, continue, or human handover.",
                    "For external actions, show the target, content, and impact first; execute once after confirmation and keep a verifiable receipt.",
                    "Save artifacts so they can be opened and traced; explain failures and the next step.",
                    "Limit which files, accounts, and networks the system can reach, and do not expose secrets directly to execution.",
                ],
            },
            {
                "num": "1.4",
                "slug": "1-4",
                "zh_title": "用真实任务验收 MVP",
                "en_title": "Accept the MVP with real tasks",
                "zh_summary": "让首位用户不依赖开发者也能独立使用。",
                "en_summary": "Make the first user independent of the developer.",
                "zh_goal": """用真实任务证明 MVP 已经可以日常使用，并让它具备安装、启动、备份和退出的基本能力。完成这个阶段后，首位用户不依赖开发者也能独立使用。""",
                "en_goal": """Prove with real tasks that the MVP can be used every day, and give it basic install, start, backup, and exit capabilities. When this step is done, the first user can use it without the developer.""",
                "zh_how": [
                    "用 1.1 确定的 10–12 个真实任务逐项验收，记录成功率、人工时间、失败类型和用户反馈。",
                    "修复最影响使用的三个问题：任务丢失、失败无法恢复、审批或产物看不懂。",
                    "提供简单的安装和启动方式，说明数据保存在哪里、如何备份和导出。",
                    "增加全局停止开关和基础权限设置，让用户随时停下系统。",
                    "让首位用户连续使用一周，收集真实使用中的问题和不愿继续使用的原因。",
                    "只有至少 8 个任务通过验收、失败可恢复、用户愿意继续使用时，MVP 才算完成。",
                ],
                "en_how": [
                    "Accept against the 10–12 real tasks from 1.1, recording success, manual time, failure types, and user feedback.",
                    "Fix the three issues that hurt use most: lost tasks, unrecoverable failures, and confusing approval or artifacts.",
                    "Provide a simple install and start path, and explain where data lives and how to back up or export it.",
                    "Add a global stop switch and basic permission settings so the user can stop the system at any time.",
                    "Have the first user use it for a week and collect real problems and reasons they might stop using it.",
                    "The MVP is complete only when at least 8 tasks pass, failures can be recovered, and the user wants to continue.",
                ],
            },
        ],
    },
    {
        "num": 2,
        "slug": "stage-2",
        "zh_title": "日常内容工作",
        "en_title": "Everyday Content Work",
        "zh_summary": "从窄任务族扩展到邮件、日历、文档、表格和网页。",
        "en_summary": "Expand from one narrow task family to email, calendar, documents, tables, and the web.",
        "zh_outcome": "能处理日常内容并在审批后安全写入的个人操作员",
        "en_outcome": "A personal operator that handles everyday content and writes safely after approval",
        "zh_goal": """第二阶段把 Hearth 从一个窄任务族扩展到大多数日常内容工作：读取邮件、日历、文件和知识库，处理文档、表格和网页资料，起草内容，并在审批后发送或写入。顺序必须是先只读、再起草、最后才执行外部写入。""",
        "en_goal": """Phase 2 expands Hearth from one narrow task family to most everyday content work: reading email, calendars, files, and knowledge bases; handling documents, tables, and web material; drafting content; and sending or writing after approval. The order must be read-only first, drafting second, and external writes last.""",
        "zh_how": [
            "先接入只读信息来源，让用户看到系统读到了什么。",
            "再加入文档、表格和网页资料的处理与引用。",
            "然后打通起草、审批和测试账户下的发送或写入。",
            "最后用真实日常任务验收时间节省、结果准确和失败恢复。",
        ],
        "en_how": [
            "Connect read-only sources first so the user can see what was read.",
            "Add document, table, and web material processing with citations.",
            "Then complete drafting, approval, and sending or writing under a test account.",
            "Finally accept with real daily tasks for time saved, accuracy, and failure recovery.",
        ],
        "modules": [
            {
                "num": "2.1",
                "slug": "2-1",
                "zh_title": "接入只读信息源",
                "en_title": "Connect read-only information sources",
                "zh_summary": "让用户看到系统读取了什么，以及来源是否可靠。",
                "en_summary": "Show what the system read and where it came from.",
                "zh_goal": """让 Hearth 能安全地读取用户日常使用的信息来源，并把来源、时间和权限清楚地展示给用户。这个阶段只读，不发送、不修改、不删除。""",
                "en_goal": """Let Hearth safely read the sources the user uses every day, and show the source, time, and permission clearly. This step is read-only: no sending, editing, or deleting.""",
                "zh_how": [
                    "先接一个邮件来源、一个日历来源、一个文件来源和一个知识库来源，不要一次铺开。",
                    "每次读取都记录来源、时间、账户和权限范围，用户能查到信息从哪里来。",
                    "对重复内容去重，对新增和变化做增量更新，避免每次全量重读。",
                    "遇到登录失效、权限不足或来源不可用时，明确告诉用户，不要静默失败。",
                    "提供断开来源和清除已读取内容的入口。",
                    "用真实账户验证：用户能看到系统读了什么，也能确认系统没有写入。",
                ],
                "en_how": [
                    "Connect one email source, one calendar source, one file source, and one knowledge base first; do not open everything at once.",
                    "Record source, time, account, and permission for every read so the user can trace where information came from.",
                    "Remove duplicates and update only what changed instead of rereading everything.",
                    "When login expires, permission is missing, or a source is unavailable, tell the user clearly instead of failing silently.",
                    "Provide an entry to disconnect a source and clear what was read from it.",
                    "Verify with a real account: the user can see what was read and confirm that nothing was written.",
                ],
            },
            {
                "num": "2.2",
                "slug": "2-2",
                "zh_title": "处理文档、表格与网页资料",
                "en_title": "Process documents, tables, and web material",
                "zh_summary": "产出有来源、能核对、可继续使用的资料结果。",
                "en_summary": "Produce results with sources that can be checked and reused.",
                "zh_goal": """让 Hearth 能处理文档、表格和公开网页资料，产出可以核对的结果。重点不是“能读”，而是结果有来源、能检查、能继续使用。""",
                "en_goal": """Let Hearth process documents, tables, and public web material and produce results that can be checked. The point is not just reading; the result must have sources, be reviewable, and be reusable.""",
                "zh_how": [
                    "支持常见文档的读取、转换和摘要，保留原始文件和页码或段落位置。",
                    "支持表格的筛选、汇总和信息提取，结果要能对照原表检查。",
                    "做公开网页研究时，记录访问时间、网址、引用位置和页面变化。",
                    "网页内容一律当作不可信资料，不执行页面里的指令，不因为页面文字扩大权限。",
                    "登录页面、验证码或需要人工判断的情况，停下来交给用户处理。",
                    "所有结果都保存为可打开的产物，并标明来源和生成时间。",
                ],
                "en_how": [
                    "Support reading, converting, and summarizing common documents while keeping the original file and page or paragraph locations.",
                    "Support filtering, summarizing, and extracting information from tables, with results that can be checked against the original.",
                    "For public web research, record access time, URL, citation location, and page changes.",
                    "Treat all web content as untrusted: do not follow instructions on the page or let page text expand permissions.",
                    "For login pages, captchas, or situations that need human judgment, stop and hand over to the user.",
                    "Save every result as an artifact that can be opened, with its source and generation time.",
                ],
            },
            {
                "num": "2.3",
                "slug": "2-3",
                "zh_title": "起草、审批与外部写入",
                "en_title": "Draft, approve, and write externally",
                "zh_summary": "先草稿、再审批、最后只执行一次外部写入。",
                "en_summary": "Draft first, approve second, and execute an external write only once.",
                "zh_goal": """让 Hearth 能在用户确认后发送邮件、修改日历或写入其他工作系统，并保证同一次操作不会重复执行。先用测试账户跑通，再接触真实账户。""",
                "en_goal": """Let Hearth send email, change a calendar, or write to another work system after the user confirms, and ensure the same operation is not executed twice. Prove it with a test account before touching a real account.""",
                "zh_how": [
                    "先生成草稿，不直接发送；草稿要能修改、保存和丢弃。",
                    "审批页必须展示准确的对象、账户、内容、附件、影响和是否可撤销。",
                    "审批只在短时间内有效，并且只能使用一次；用户拒绝后不执行。",
                    "先用测试账户完成“读取—起草—审批—发送或写入—回执”的完整流程。",
                    "发送或写入后保存回执；失败时说明是否可能已经执行，并提供核对和补救方式。",
                    "只把任务真正需要的背景信息交给执行过程，并显示使用了哪些信息。",
                    "没有隔离措施时，不直接接管用户的主账户。",
                ],
                "en_how": [
                    "Generate a draft first; do not send directly. The draft can be edited, saved, or discarded.",
                    "The approval page must show the exact target, account, content, attachments, impact, and whether the action can be undone.",
                    "Approval is valid only for a short time and only once; nothing runs after the user declines.",
                    "Use a test account to complete the full flow: read, draft, approve, send or write, and receipt.",
                    "Keep a receipt after sending or writing; on failure, say whether the action may already have happened and how to check or recover.",
                    "Give the execution only the background information the task truly needs, and show which information was used.",
                    "Do not take over the user's main account without isolation.",
                ],
            },
            {
                "num": "2.4",
                "slug": "2-4",
                "zh_title": "验收日常内容工作",
                "en_title": "Accept everyday content work",
                "zh_summary": "用真实日常任务证明更少时间、更高准确和可恢复。",
                "en_summary": "Prove less time, better accuracy, and recoverability with real daily tasks.",
                "zh_goal": """用真实日常内容任务证明第二阶段的价值：用户花更少时间完成邮件、日历、文档和网页工作，同时仍能看懂、审批和恢复每一次外部操作。""",
                "en_goal": """Prove the value of Phase 2 with real everyday content tasks: the user spends less time on email, calendar, documents, and web work while still being able to understand, approve, and recover every external action.""",
                "zh_how": [
                    "选 10–15 个真实日常任务，覆盖邮件、日历、文档、表格和网页研究。",
                    "记录每个任务的人工时间、成功率、审批次数、失败原因和用户是否愿意再次使用。",
                    "检查每个结果是否有来源、能否核对，外部操作是否有回执。",
                    "检查不同账户和项目之间没有数据串扰，敏感信息没有出现在不该出现的地方。",
                    "修复最影响信任的问题：来源不清、审批信息不足、失败无法恢复。",
                    "只有当用户愿意把日常内容工作交给它，并且人工时间明显下降时，第二阶段才算完成。",
                ],
                "en_how": [
                    "Select 10–15 real daily tasks covering email, calendar, documents, tables, and web research.",
                    "Record manual time, success rate, approval count, failure reasons, and whether the user would use it again.",
                    "Check that every result has a source and can be reviewed, and that every external action has a receipt.",
                    "Check that different accounts and projects do not leak into each other, and sensitive information does not appear where it should not.",
                    "Fix the issues that hurt trust most: unclear sources, insufficient approval information, and unrecoverable failures.",
                    "Phase 2 is complete only when the user is willing to hand over daily content work and manual time clearly drops.",
                ],
            },
        ],
    },
    {
        "num": 3,
        "slug": "stage-3",
        "zh_title": "桌面操作",
        "en_title": "Desktop Operation",
        "zh_summary": "让 Hearth 操作没有开放接口的桌面软件和跨应用流程。",
        "en_summary": "Let Hearth operate desktop software and cross-application workflows without open interfaces.",
        "zh_outcome": "能操作桌面软件、可暂停、可接管、失败可恢复的助手",
        "en_outcome": "An assistant that can operate desktop software, pause, take over, and recover from failure",
        "zh_goal": """第三阶段让 Hearth 能操作没有开放接口的桌面软件和跨应用流程。顺序是先看见、再接管、再低风险操作，最后才开放高风险操作。任何无法观察、无法暂停或无法接管的情况，都不允许自动执行。""",
        "en_goal": """Phase 3 lets Hearth operate desktop software and cross-application workflows that have no open interface. The order is observe first, take over second, low-risk actions third, and high-risk actions last. If the system cannot observe, pause, or hand over, it must not act automatically.""",
        "zh_how": [
            "先让用户看到并信任桌面设备。",
            "再让用户能观察、暂停和接管操作。",
            "然后在白名单应用内完成低风险操作。",
            "最后才开放高风险操作，并准备快照、补偿和恢复演练。",
        ],
        "en_how": [
            "First let the user see and trust the desktop device.",
            "Then let the user observe, pause, and take over.",
            "Then complete low-risk actions in allowlisted applications.",
            "Only then open high-risk actions, with snapshots, compensation, and recovery drills.",
        ],
        "modules": [
            {
                "num": "3.1",
                "slug": "3-1",
                "zh_title": "连接并查看桌面设备",
                "en_title": "Connect and inspect a desktop device",
                "zh_summary": "让用户看清设备、权限范围和停止入口。",
                "en_summary": "Make the device, scope, and stop control clear to the user.",
                "zh_goal": """让用户能把一台电脑安全地连接到 Hearth，并清楚看到这台设备能做什么、当前是否在线、允许操作哪些应用。""",
                "en_goal": """Let the user safely connect a computer to Hearth and clearly see what the device can do, whether it is online, and which applications it may operate.""",
                "zh_how": [
                    "提供简单的桌面助手安装和配对流程，用户在 Hearth 里确认后才建立连接。",
                    "显示设备名称、在线状态、可用的操作范围和最近一次活动时间。",
                    "只允许用户明确选择的应用和窗口，不默认开放整个桌面。",
                    "连接期间始终显示可见提示，用户能随时暂停或断开。",
                    "提供撤销设备入口；撤销后设备不能继续操作或查看任务。",
                    "用真实设备验证：用户能看懂权限范围，也能立即停止连接。",
                ],
                "en_how": [
                    "Provide a simple install and pairing flow for the desktop helper; connect only after the user confirms in Hearth.",
                    "Show the device name, online state, available scope, and last activity time.",
                    "Allow only applications and windows the user explicitly selects; do not open the whole desktop by default.",
                    "Show a visible indicator while connected, and let the user pause or disconnect at any time.",
                    "Provide a device revocation entry; after revocation, the device cannot operate or view tasks.",
                    "Verify with a real device: the user understands the scope and can stop the connection immediately.",
                ],
            },
            {
                "num": "3.2",
                "slug": "3-2",
                "zh_title": "观察桌面与人工接管",
                "en_title": "Observe the desktop and take over",
                "zh_summary": "让用户看见操作过程，并能暂停、接管和交还。",
                "en_summary": "Let the user see the work, pause, take over, and hand back.",
                "zh_goal": """让用户能看见 Hearth 正在操作的窗口和步骤，并在需要时暂停自动操作、自己接管、完成后再交还。""",
                "en_goal": """Let the user see which window Hearth is operating and what step it is on, then pause automatic operation, take over personally, and hand back when finished.""",
                "zh_how": [
                    "显示当前窗口、操作步骤和下一步计划，避免用户不知道系统在做什么。",
                    "提供暂停、继续、接管和终止四个明确动作。",
                    "用户接管时立即停止自动输入，交还时先确认当前状态再继续。",
                    "对密码、聊天内容等敏感区域做遮挡，不把完整屏幕长期保存。",
                    "记录每次接管、暂停和终止的原因，方便事后核对。",
                    "如果无法观察窗口或无法接管，系统必须停下，不允许继续自动操作。",
                ],
                "en_how": [
                    "Show the current window, operation step, and next plan so the user is not left guessing.",
                    "Provide four clear actions: pause, continue, take over, and stop.",
                    "Stop automatic input immediately when the user takes over, and confirm the current state before continuing.",
                    "Mask sensitive areas such as passwords and chat content, and do not keep full screenshots for a long time.",
                    "Record the reason for every takeover, pause, and stop so it can be reviewed later.",
                    "If the window cannot be observed or the user cannot take over, the system must stop and must not continue automatically.",
                ],
            },
            {
                "num": "3.3",
                "slug": "3-3",
                "zh_title": "分级完成桌面操作",
                "en_title": "Complete desktop actions by risk level",
                "zh_summary": "低风险先做，高风险必须可预览、可确认、可恢复。",
                "en_summary": "Start with low-risk actions; high-risk actions need preview, confirmation, and recovery.",
                "zh_goal": """让 Hearth 能在用户允许的应用里完成低风险桌面操作，并在确认结果后再处理高风险操作。每一步都要能验证，不能只靠“看起来完成了”。""",
                "en_goal": """Let Hearth complete low-risk desktop actions in applications the user allows, and only then handle high-risk actions. Every step must be verified; looking finished is not enough.""",
                "zh_how": [
                    "先做低风险操作：打开文件、定位菜单、填写草稿、导出结果。",
                    "每一步都通过窗口内容和操作后的变化确认结果，必要时截图留证。",
                    "失败时先停下，说明是窗口丢失、权限变化、输入冲突还是结果不符，再决定重试或转人工。",
                    "高风险操作先在隔离桌面中预览影响，要求二次确认，并准备快照或补偿办法。",
                    "检测到只完成一半、窗口被关闭或用户开始操作时，立即停止并交还。",
                    "不读取密码库，不修改系统安全设置，不执行没有恢复路径的不可逆操作。",
                ],
                "en_how": [
                    "Start with low-risk actions: open a file, find a menu, fill a draft, export a result.",
                    "Verify each step from window content and the change after the action; keep a screenshot as evidence when needed.",
                    "On failure, stop first and explain whether the window was lost, permission changed, input conflicted, or the result did not match; then retry or hand over.",
                    "For high-risk actions, preview the impact in an isolated desktop, require a second confirmation, and prepare a snapshot or compensation.",
                    "If the action is only half done, the window closes, or the user starts working, stop immediately and hand back.",
                    "Do not read password vaults, change system security settings, or perform irreversible actions without a recovery path.",
                ],
            },
            {
                "num": "3.4",
                "slug": "3-4",
                "zh_title": "验收桌面操作",
                "en_title": "Accept desktop operation",
                "zh_summary": "用真实桌面任务证明可看懂、可接管、可停止。",
                "en_summary": "Prove with real desktop tasks that it is understandable, interruptible, and stoppable.",
                "zh_goal": """用真实桌面任务证明第三阶段可用：用户能看懂、能接管、能停止，失败不会留下难以收拾的半完成状态。""",
                "en_goal": """Prove Phase 3 with real desktop tasks: the user can understand, take over, and stop, and a failure does not leave a difficult half-finished state.""",
                "zh_how": [
                    "选择至少 5 个真实桌面任务，覆盖不同应用和操作复杂度。",
                    "记录完成率、接管次数、人工时间、失败原因和用户是否能理解系统动作。",
                    "检查每次操作都有可见过程、验证结果和停止入口。",
                    "检查高风险操作是否有影响预览、二次确认和补偿办法。",
                    "做一次失败演练：窗口丢失、权限变化或用户接管时，系统能安全停下。",
                    "只有当用户愿意在真实工作中使用，并且失败可恢复时，第三阶段才算完成。",
                ],
                "en_how": [
                    "Select at least 5 real desktop tasks across different applications and complexity levels.",
                    "Record completion rate, takeover count, manual time, failure reasons, and whether the user understands the actions.",
                    "Check that every action has a visible process, a verification result, and a stop control.",
                    "Check that high-risk actions have an impact preview, second confirmation, and compensation.",
                    "Run a failure drill: the system stops safely when a window is lost, permission changes, or the user takes over.",
                    "Phase 3 is complete only when the user is willing to use it in real work and failures can be recovered.",
                ],
            },
        ],
    },
    {
        "num": 4,
        "slug": "stage-4",
        "zh_title": "主动服务与手机入口",
        "en_title": "Proactive Service and Mobile Entry",
        "zh_summary": "在有限授权内主动工作，并把手机作为审批和接管入口。",
        "en_summary": "Work proactively within limited authority and use the phone for approval and takeover.",
        "zh_outcome": "能在合适时机提醒，并可在手机上审批和接管的助手",
        "en_outcome": "An assistant that speaks at the right time and can be approved or taken over from a phone",
        "zh_goal": """第四阶段让 Hearth 在有限授权内主动工作，并把手机变成查看、审批和接管入口。重点不是“自动运行”，而是在正确的时间做正确的事，并且不制造打扰。""",
        "en_goal": """Phase 4 lets Hearth work proactively within limited authority and turns the phone into an entry for viewing, approval, and takeover. The point is not automatic running; it is doing the right thing at the right time without creating noise.""",
        "zh_how": [
            "先建立触发条件和主动建议，不直接自动执行。",
            "再把建议集中到主动收件箱，让用户决定接受、忽略或转成任务。",
            "然后交付手机入口，支持查看、审批和接管。",
            "最后用注意力预算和真实任务验收，确保主动模式安静、可控、可撤销。",
        ],
        "en_how": [
            "First create triggers and proactive suggestions without automatic execution.",
            "Then gather suggestions in a proactive inbox where the user can accept, ignore, or turn them into tasks.",
            "Then deliver the phone entry for viewing, approval, and takeover.",
            "Finally accept with an attention budget and real tasks so proactive mode stays quiet, controllable, and revocable.",
        ],
        "modules": [
            {
                "num": "4.1",
                "slug": "4-1",
                "zh_title": "设置触发条件与主动建议",
                "en_title": "Set triggers and proactive suggestions",
                "zh_summary": "发现值得处理的事，并解释为什么现在重要。",
                "en_summary": "Find work worth doing and explain why it matters now.",
                "zh_goal": """让 Hearth 能从用户授权的信息来源中发现值得处理的事情，并解释为什么现在需要用户关注。这个阶段只提出建议，不自动执行高风险动作。""",
                "en_goal": """Let Hearth find work worth handling in sources the user has authorized and explain why it needs attention now. This step only suggests; it does not automatically perform high-risk actions.""",
                "zh_how": [
                    "从邮件、日历、文件和已有关注事项中产生候选事件。",
                    "对重复事件去重，设置冷却时间，避免同一件事反复提醒。",
                    "每条建议都说明来源、为什么现在重要、建议做什么、预计影响和是否需要审批。",
                    "用户可以选择接受、忽略、稍后提醒或转成普通任务。",
                    "先在不产生真实影响的情况下试运行，观察建议是否准确、是否过多。",
                    "没有明确授权、预算或停止方式时，不开放主动执行。",
                ],
                "en_how": [
                    "Generate candidate events from email, calendar, files, and existing follow-ups.",
                    "Remove duplicates and add a cooldown so the same item is not raised repeatedly.",
                    "Each suggestion explains its source, why it matters now, the proposed action, expected impact, and whether approval is needed.",
                    "The user can accept, ignore, remind later, or turn it into a normal task.",
                    "Trial it without real impact first and observe whether suggestions are accurate and not excessive.",
                    "Do not enable proactive execution without clear authority, budget, and a stop control.",
                ],
            },
            {
                "num": "4.2",
                "slug": "4-2",
                "zh_title": "建立主动收件箱",
                "en_title": "Build the proactive inbox",
                "zh_summary": "把建议集中到一个容易判断和处理的地方。",
                "en_summary": "Gather suggestions where they are easy to judge and handle.",
                "zh_goal": """把主动建议集中到一个用户容易处理的地方，让用户一眼看出什么重要、为什么重要、需要自己做什么。""",
                "en_goal": """Gather proactive suggestions in one place the user can handle easily, so it is clear what matters, why it matters, and what the user needs to do.""",
                "zh_how": [
                    "建立统一的主动收件箱，按重要性和时间分组，不把建议散落在各个页面。",
                    "每条内容显示来源、建议动作、预计影响、预计花费和是否需要审批。",
                    "提供接受、忽略、稍后提醒和转成任务四个动作，避免重复打扰。",
                    "支持安静时段、每日上限和批量处理，让用户能控制被打扰的程度。",
                    "用户忽略后不要换一种说法继续推送；同一事件只保留一条记录。",
                    "用真实建议检验：用户能快速判断，且不会因为数量过多而关闭通知。",
                ],
                "en_how": [
                    "Create one proactive inbox grouped by importance and time; do not scatter suggestions across pages.",
                    "Each item shows the source, proposed action, expected impact, expected cost, and whether approval is needed.",
                    "Provide accept, ignore, remind later, and turn-into-task actions to avoid repeated interruption.",
                    "Support quiet hours, a daily limit, and batch handling so the user controls how often they are interrupted.",
                    "After the user ignores an item, do not rephrase and push it again; keep one record per event.",
                    "Test with real suggestions: the user can judge quickly and does not turn notifications off because there are too many.",
                ],
            },
            {
                "num": "4.3",
                "slug": "4-3",
                "zh_title": "手机查看、审批与接管",
                "en_title": "View, approve, and take over on the phone",
                "zh_summary": "手机只保留关键动作和短期权限，丢失后可立即撤销。",
                "en_summary": "Keep only key actions and short-lived authority on the phone, revocable if lost.",
                "zh_goal": """让用户在手机上完成最关键的查看、审批和接管，同时保证手机丢失后可以立即撤销，不把长期主权限放在手机上。""",
                "en_goal": """Let the user view, approve, and take over from a phone, while ensuring a lost phone can be revoked immediately and long-term primary authority is not stored on it.""",
                "zh_how": [
                    "提供手机网页入口，支持查看今日任务、需要你处理的事项和产物。",
                    "审批页展示真实对象、内容、影响和是否可撤销，关键操作要求再次确认。",
                    "支持在手机上暂停、接管和终止任务，接管时立即停止自动操作。",
                    "用短期配对码建立连接，手机不保存长期主权限；推送内容不包含敏感正文。",
                    "手机丢失时可以立即撤销，撤销后不能继续审批、接管或查看任务。",
                    "断网时只提供只读和明确的状态提示，恢复后再同步。",
                ],
                "en_how": [
                    "Provide a phone web entry for today's tasks, items that need the user, and artifacts.",
                    "The approval page shows the real target, content, impact, and whether it can be undone; key actions require a second confirmation.",
                    "Support pause, takeover, and stop from the phone; takeover stops automatic operation immediately.",
                    "Pair with a short-lived code; the phone does not store long-term primary authority, and push content does not include sensitive text.",
                    "A lost phone can be revoked immediately; after revocation it cannot approve, take over, or view tasks.",
                    "When offline, offer read-only access and a clear state, then sync after reconnecting.",
                ],
            },
            {
                "num": "4.4",
                "slug": "4-4",
                "zh_title": "控制打扰与验收主动服务",
                "en_title": "Control interruption and accept proactive service",
                "zh_summary": "主动模式要安静、有用、可控，并且可以随时关掉。",
                "en_summary": "Proactive mode must be quiet, useful, controllable, and easy to turn off.",
                "zh_goal": """让主动模式安静、有用、可控，并通过真实任务证明它没有变成通知噪音。""",
                "en_goal": """Make proactive mode quiet, useful, and controllable, and prove with real tasks that it has not become notification noise.""",
                "zh_how": [
                    "设置每日打断上限、安静时段和同类事件聚合规则。",
                    "提供随时暂停、降级和关闭主动模式的入口，并说明当前处于哪种模式。",
                    "记录每条主动建议是否被接受、忽略或转成任务，以及用户是否觉得有用。",
                    "用 5–10 个真实主动任务检验：平均每个任务打断不超过一次，用户能理解为什么被提醒。",
                    "高风险动作仍然需要审批，手机审批不能被重复使用。",
                    "如果用户开始关闭通知、忽略审批或觉得被打扰，先降低主动性，而不是继续增加功能。",
                ],
                "en_how": [
                    "Set a daily interruption limit, quiet hours, and grouping rules for similar events.",
                    "Provide entries to pause, degrade, or turn off proactive mode at any time, and show which mode is active.",
                    "Record whether each suggestion was accepted, ignored, or turned into a task, and whether the user found it useful.",
                    "Test with 5–10 real proactive tasks: no more than one interruption per task on average, and the user understands why they were notified.",
                    "High-risk actions still require approval, and phone approvals cannot be reused.",
                    "If the user starts turning off notifications, ignoring approvals, or feeling interrupted, reduce proactivity instead of adding features.",
                ],
            },
        ],
    },
    {
        "num": 5,
        "slug": "stage-5",
        "zh_title": "记忆与能力进化",
        "en_title": "Memory and Capability Evolution",
        "zh_summary": "让系统积累背景并改进方法，但所有变化都可查看、可纠正、可回退。",
        "en_summary": "Let the system accumulate context and improve methods, with every change visible, correctable, and reversible.",
        "zh_outcome": "会积累背景、改进方法且可纠正可回退的助手",
        "en_outcome": "An assistant that accumulates context and improves methods while staying correctable and reversible",
        "zh_goal": """第五阶段让 Hearth 积累个人背景并改进工作方法，但所有记忆都必须可查看、可纠正、可遗忘、可导出，所有新方法都必须经过评估、试用和回退。""",
        "en_goal": """Phase 5 lets Hearth accumulate personal context and improve how it works, but every memory must be visible, correctable, forgettable, and exportable, and every new method must be evaluated, trialed, and reversible.""",
        "zh_how": [
            "先建立可查看、可纠正的记忆。",
            "再处理遗忘、导出和敏感信息边界。",
            "然后从真实任务中总结可复用方法。",
            "最后用评估、小范围试用和回退验收。",
        ],
        "en_how": [
            "First create memory that can be viewed and corrected.",
            "Then handle forgetting, export, and sensitive-information boundaries.",
            "Then summarize reusable methods from real tasks.",
            "Finally accept with evaluation, small-scale trials, and rollback.",
        ],
        "modules": [
            {
                "num": "5.1",
                "slug": "5-1",
                "zh_title": "建立可查看的记忆",
                "en_title": "Create visible memory",
                "zh_summary": "记住有用的信息，并说明来源和用途。",
                "en_summary": "Remember useful information and explain its source and use.",
                "zh_goal": """让 Hearth 记住对用户真正有用的信息，并能说明每条记忆从哪里来、为什么被使用。用户必须能查看和修改这些记忆。""",
                "en_goal": """Let Hearth remember information that is genuinely useful to the user and explain where each memory came from and why it was used. The user must be able to view and edit these memories.""",
                "zh_how": [
                    "记录用户事实、项目背景、偏好、承诺和过去任务经验，但只记录有来源的信息。",
                    "每条记忆都标明来源、时间、可信程度、适用范围和敏感程度。",
                    "提供记忆浏览器，用户能看到记住了什么、最近在哪里被使用。",
                    "任务使用记忆时，说明用了哪几条以及为什么相关，避免黑箱召回。",
                    "只把任务需要的最小背景交给执行过程，不把所有记忆一次性塞进去。",
                    "用户修改或删除记忆后，后续任务立即使用新版本。",
                ],
                "en_how": [
                    "Record user facts, project context, preferences, commitments, and past task experience, but only with a source.",
                    "Each memory states its source, time, confidence, scope, and sensitivity.",
                    "Provide a memory browser where the user can see what was remembered and where it was recently used.",
                    "When a task uses memory, explain which items were used and why they were relevant; avoid a black box.",
                    "Give the execution only the minimum background the task needs; do not dump every memory into every task.",
                    "After the user edits or deletes a memory, later tasks use the new version immediately.",
                ],
            },
            {
                "num": "5.2",
                "slug": "5-2",
                "zh_title": "纠正、遗忘与导出记忆",
                "en_title": "Correct, forget, and export memory",
                "zh_summary": "错误记忆可以改，敏感信息可以忘，全部数据可以带走。",
                "en_summary": "Wrong memories can be fixed, sensitive information can be forgotten, and all data can be taken away.",
                "zh_goal": """让错误或过期的记忆可以被纠正、遗忘和导出，并确保敏感信息不会在不允许的场景被使用。""",
                "en_goal": """Let wrong or outdated memories be corrected, forgotten, and exported, and ensure sensitive information is not used in disallowed contexts.""",
                "zh_how": [
                    "当新旧记忆冲突时，保留来源和时间，展示冲突并采用用户确认的版本。",
                    "删除记忆时，同时清理由它产生的摘要、索引和关联内容，避免从别处再次出现。",
                    "提供完整的记忆导出，格式可读，用户可以带走或迁移。",
                    "敏感信息只在明确允许的任务和场景中使用，不因为一次授权而永久放开。",
                    "外部网页、邮件和文件内容不能直接写入记忆或扩大权限，可疑内容先隔离。",
                    "用真实纠正和遗忘操作验证：用户删除后，后续任务不再使用旧内容。",
                ],
                "en_how": [
                    "When old and new memories conflict, keep both sources and times, show the conflict, and use the version the user confirms.",
                    "When deleting a memory, also clear summaries, indexes, and related content derived from it so it does not reappear elsewhere.",
                    "Provide a complete memory export in a readable format that the user can take away or migrate.",
                    "Use sensitive information only in explicitly allowed tasks and contexts; one approval does not open it forever.",
                    "External web, email, and file content cannot write memory directly or expand permission; isolate suspicious content first.",
                    "Verify with real correction and forgetting: after the user deletes something, later tasks no longer use it.",
                ],
            },
            {
                "num": "5.3",
                "slug": "5-3",
                "zh_title": "总结并评估可复用方法",
                "en_title": "Summarize and evaluate reusable methods",
                "zh_summary": "新方法先做候选，经过评估和小范围试用后才能采用。",
                "en_summary": "New methods start as candidates and are adopted only after evaluation and a small trial.",
                "zh_goal": """让 Hearth 从成功任务中总结可复用的方法，但新方法只能作为候选，必须经过评估和小范围试用后才能成为正式能力。""",
                "en_goal": """Let Hearth summarize reusable methods from successful tasks, but new methods start only as candidates and must pass evaluation and a small trial before becoming official capabilities.""",
                "zh_how": [
                    "从多次成功的真实任务中提取共同步骤，形成带适用范围和示例的候选方法。",
                    "为候选方法准备成功样本、失败样本和对照结果，避免只挑好看的数据。",
                    "先在不产生真实影响的情况下试运行，再在小范围真实任务中试用。",
                    "试用期间比较成功率、人工时间、成本和失败类型，用户能看懂差异。",
                    "新方法不能自动扩大权限，涉及高风险动作时仍然需要审批。",
                    "保留旧版本，出现问题时可以立即退回。",
                ],
                "en_how": [
                    "Extract common steps from several successful real tasks into a candidate method with scope and examples.",
                    "Prepare success samples, failure samples, and comparison results for the candidate; do not cherry-pick favorable data.",
                    "Trial it without real impact first, then on a small set of real tasks.",
                    "During the trial, compare success rate, manual time, cost, and failure types in a way the user can understand.",
                    "A new method cannot expand permission automatically, and high-risk actions still require approval.",
                    "Keep the old version so it can be restored immediately if something goes wrong.",
                ],
            },
            {
                "num": "5.4",
                "slug": "5-4",
                "zh_title": "验收记忆与进化",
                "en_title": "Accept memory and evolution",
                "zh_summary": "证明记忆和新方法真的有用，同时不会失控或无法回退。",
                "en_summary": "Prove memory and new methods are useful without becoming uncontrolled or irreversible.",
                "zh_goal": """用真实使用证明记忆和新方法确实有帮助，同时不会带来错误召回、权限扩大或无法回退的风险。""",
                "en_goal": """Prove with real use that memory and new methods genuinely help, without wrong recall, permission expansion, or an inability to roll back.""",
                "zh_how": [
                    "检查记忆是否准确、来源是否清楚、纠正和遗忘是否生效、导出是否完整。",
                    "至少让一个候选方法走完“提出—评估—小范围试用—正式采用—退回”的完整流程。",
                    "记录采用前后的成功率、人工时间、成本和用户感受。",
                    "检查新方法没有扩大权限，也没有把高风险动作变成自动执行。",
                    "做一次错误记忆和错误方法演练，确认用户可以纠正并恢复。",
                    "只有当用户能理解系统为什么记住、为什么采用，并且随时可以改回时，第五阶段才算完成。",
                ],
                "en_how": [
                    "Check that memory is accurate, sources are clear, correction and forgetting work, and export is complete.",
                    "Take at least one candidate method through the full path: propose, evaluate, small trial, adopt, roll back.",
                    "Record success rate, manual time, cost, and user experience before and after adoption.",
                    "Check that the new method did not expand permission and did not turn high-risk actions into automatic execution.",
                    "Run a wrong-memory and wrong-method drill to confirm the user can correct and recover.",
                    "Phase 5 is complete only when the user understands why something was remembered or adopted and can always change it back.",
                ],
            },
        ],
    },
    {
        "num": 6,
        "slug": "stage-6",
        "zh_title": "多设备与长期运行",
        "en_title": "Multi-device and Long-running Operation",
        "zh_summary": "让同一套任务、记忆和授权在多台设备上长期安全使用。",
        "en_summary": "Let the same tasks, memory, and authority run safely across devices over the long term.",
        "zh_outcome": "可多设备使用、可迁移、可长期运行的个人 Agent OS",
        "en_outcome": "A multi-device, portable, long-running Personal Agent OS",
        "zh_goal": """第六阶段把单机产品扩展为可以长期运行、在多台设备之间保持一致、可备份、可迁移、可撤销的个人 Agent OS。多设备不是复制多个 Agent，而是同一套任务、记忆和授权在不同设备上继续使用。""",
        "en_goal": """Phase 6 expands the single-device product into a Personal Agent OS that runs for the long term, stays consistent across devices, can be backed up, migrated, and revoked. Multi-device does not mean copying multiple agents; it means the same tasks, memory, and authority continue on different devices.""",
        "zh_how": [
            "先让多台设备看到一致的任务和产物。",
            "再处理断网、设备切换和能力分配。",
            "然后补齐设备撤销、备份、恢复和升级。",
            "最后做长期运行和完整验收，形成 v1.0。",
        ],
        "en_how": [
            "First make tasks and artifacts consistent across devices.",
            "Then handle offline use, device switching, and capability routing.",
            "Then complete device revocation, backup, restore, and upgrade.",
            "Finally run the long-term test and full acceptance for v1.0.",
        ],
        "modules": [
            {
                "num": "6.1",
                "slug": "6-1",
                "zh_title": "多设备同步与切换",
                "en_title": "Sync and switch across devices",
                "zh_summary": "同一套任务和产物在不同设备上保持一致。",
                "en_summary": "Keep the same tasks and artifacts consistent across devices.",
                "zh_goal": """让用户在电脑、手机和其他设备上看到同一套任务、产物和记忆，切换设备时不丢任务，也不会出现两个互相矛盾的 Agent。""",
                "en_goal": """Let the user see the same tasks, artifacts, and memory on a computer, phone, and other devices; switching devices does not lose tasks or create two conflicting agents.""",
                "zh_how": [
                    "为每台设备建立独立身份，用户能查看、命名和移除设备。",
                    "任务、产物和记忆的变化按时间同步，设备重新上线后只补缺失部分。",
                    "发生冲突时保留两边记录，按明确规则合并，无法判断时交给用户。",
                    "同一时间只有一个设备负责执行同一个任务，避免重复操作。",
                    "断网时允许排队，恢复后继续；已经执行过的外部操作不能再次执行。",
                    "用两台真实设备验证：切换后状态一致，任务不丢，产物可打开。",
                ],
                "en_how": [
                    "Give each device its own identity; the user can view, name, and remove devices.",
                    "Sync task, artifact, and memory changes by time, and let a returning device catch up only on what it missed.",
                    "On conflict, keep both records, merge by a clear rule, and ask the user when it cannot decide.",
                    "Only one device is responsible for executing a task at a time to avoid duplicate actions.",
                    "Allow queuing while offline and continue after reconnecting; an external action that already happened must not run again.",
                    "Verify with two real devices: state matches after switching, tasks are not lost, and artifacts open.",
                ],
            },
            {
                "num": "6.2",
                "slug": "6-2",
                "zh_title": "设备撤销与安全迁移",
                "en_title": "Revoke devices and migrate safely",
                "zh_summary": "设备丢失后可立即失效，更换设备时数据完整转移。",
                "en_summary": "A lost device can be disabled immediately, and data moves fully when replacing it.",
                "zh_goal": """让设备丢失、更换或迁移时可以安全撤销和转移，撤销后旧设备不能再审批、接管或查看数据。""",
                "en_goal": """Let a lost, replaced, or migrated device be revoked and transferred safely; after revocation, the old device cannot approve, take over, or view data.""",
                "zh_how": [
                    "提供立即撤销设备的入口，撤销后所有会话和审批权限同时失效。",
                    "撤销后检查旧设备不能继续接收任务、查看产物或执行操作。",
                    "更换设备时使用安全迁移流程，迁移后核对任务、产物、记忆和授权。",
                    "按设备能力分配任务：桌面操作交给有桌面能力的设备，手机只做查看、审批和接管。",
                    "记录撤销和迁移过程，方便用户核对。",
                    "做一次设备丢失演练：从撤销到确认旧设备失效，整个过程可完成。",
                ],
                "en_how": [
                    "Provide an immediate revoke entry; after revocation, all sessions and approval authority become invalid at once.",
                    "After revocation, verify the old device cannot receive tasks, view artifacts, or perform actions.",
                    "Use a safe migration flow when replacing a device, then verify tasks, artifacts, memory, and authority afterwards.",
                    "Route tasks by device capability: desktop actions go to a device with desktop ability; the phone only views, approves, and takes over.",
                    "Record the revocation and migration so the user can review them.",
                    "Run a lost-device drill from revocation to confirming the old device is disabled.",
                ],
            },
            {
                "num": "6.3",
                "slug": "6-3",
                "zh_title": "备份、恢复与升级",
                "en_title": "Back up, restore, and upgrade",
                "zh_summary": "换机器、换版本或误操作都不丢任务、产物和记忆。",
                "en_summary": "Changing machines, versions, or making a mistake does not lose tasks, artifacts, or memory.",
                "zh_goal": """让用户可以完整备份、恢复、导出和升级，不因为换机器、版本变化或误操作丢失任务、产物和记忆。""",
                "en_goal": """Let the user fully back up, restore, export, and upgrade without losing tasks, artifacts, or memory when changing machines, versions, or making a mistake.""",
                "zh_how": [
                    "提供加密备份，包含任务、产物、记忆、设置和必要的授权信息。",
                    "支持完整恢复和选择性导出，恢复后能核对内容是否齐全。",
                    "升级前检查版本兼容性和空间，升级失败可以退回旧版本。",
                    "迁移后验证任务状态、产物、记忆和技能仍然可用。",
                    "提供清楚的备份位置、恢复步骤和失败说明，用户不需要开发者协助。",
                    "用一次完整迁移演练验证：备份、恢复、升级、退回都能完成。",
                ],
                "en_how": [
                    "Provide encrypted backup that includes tasks, artifacts, memory, settings, and necessary authority information.",
                    "Support full restore and selective export, and let the user verify that everything is present after restore.",
                    "Check version compatibility and space before upgrading, and allow rollback if the upgrade fails.",
                    "After migration, verify that task state, artifacts, memory, and skills still work.",
                    "Explain where backups live, how to restore, and what to do if it fails, without requiring the developer.",
                    "Run one complete migration drill: backup, restore, upgrade, and rollback all succeed.",
                ],
            },
            {
                "num": "6.4",
                "slug": "6-4",
                "zh_title": "长期运行与 v1.0 验收",
                "en_title": "Long-running operation and v1.0 acceptance",
                "zh_summary": "长期稳定运行，完成整体验收后发布 v1.0。",
                "en_summary": "Run stably for the long term, then release v1.0 after full acceptance.",
                "zh_goal": """让 Hearth 可以长期安静运行，并在完成全部能力验收后发布 v1.0。长期运行不只是“不崩溃”，还要资源可控、状态不漂移、权限不扩大。""",
                "en_goal": """Let Hearth run quietly for the long term and release v1.0 after full capability acceptance. Long-running operation is not just avoiding crashes; resources must stay bounded, state must not drift, and permission must not expand.""",
                "zh_how": [
                    "增加健康检查、资源上限、日志和异常提醒，出现问题时用户能知道。",
                    "定期清理临时文件、过期任务和不再需要的缓存，避免长期占用资源。",
                    "做至少数周的连续运行测试，检查内存、任务状态、同步和权限是否稳定。",
                    "完成覆盖主要任务类型的整体验收，包括安装、升级、备份、恢复、撤销和隐私说明。",
                    "检查所有高风险动作仍然需要审批，所有外部操作都有回执。",
                    "只有当用户可以独立安装、长期使用、迁移和退出时，才发布 v1.0。",
                ],
                "en_how": [
                    "Add health checks, resource limits, logs, and alerts so the user knows when something is wrong.",
                    "Regularly clean temporary files, expired tasks, and unneeded caches so resources do not grow forever.",
                    "Run a continuous test for at least several weeks and check memory, task state, sync, and permission stability.",
                    "Complete overall acceptance across the main task types, including install, upgrade, backup, restore, revocation, and a privacy explanation.",
                    "Check that every high-risk action still requires approval and every external action has a receipt.",
                    "Release v1.0 only when the user can install, use, migrate, and leave independently.",
                ],
            },
        ],
    },
]


def yaml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.rstrip() + "\n", encoding="utf-8")


def render_module(phase: dict, module: dict, lang: str) -> str:
    prefix = "" if lang == "zh" else "/en"
    title = module[f"{lang}_title"]
    summary = module[f"{lang}_summary"]
    goal = module[f"{lang}_goal"]
    steps = module[f"{lang}_how"]
    heading = f"{module['num']} {title}"
    step_intro = "怎么做" if lang == "zh" else "How to do it"
    numbered = "\n".join(f"{index}. {step}" for index, step in enumerate(steps, 1))
    return f"""---
title: {yaml_string(heading)}
description: {yaml_string(summary)}
outline: [2, 3]
---

# {heading}

## {'目标' if lang == 'zh' else 'Goal'}

{goal}

## {step_intro}

{numbered}
"""


def render_stage(phase: dict, lang: str) -> str:
    prefix = "" if lang == "zh" else "/en"
    cn_number = CN_NUMBERS[phase["num"] - 1]
    stage_title = (
        f"第{cn_number}阶段 · {phase['zh_title']}"
        if lang == "zh"
        else f"Phase {phase['num']} · {phase['en_title']}"
    )
    summary = phase[f"{lang}_summary"]
    goal = phase[f"{lang}_goal"]
    steps = phase[f"{lang}_how"]
    heading = "小阶段" if lang == "zh" else "Steps"
    goal_heading = "目标" if lang == "zh" else "Goal"
    how_heading = "怎么做" if lang == "zh" else "How to do it"
    table_header = "| 小阶段 | 目标 |" if lang == "zh" else "| Step | Goal |"
    rows = []
    for module in phase["modules"]:
        link = f"{prefix}/delivery/{phase['slug']}/{module['slug']}"
        rows.append(f"| [{module['num']} {module[f'{lang}_title']}]({link}) | {module[f'{lang}_summary']} |")
    intro = (
        "本阶段分为四个小阶段："
        if lang == "zh"
        else "This phase has four steps:"
    )
    numbered = "\n".join(f"{index}. {step}" for index, step in enumerate(steps, 1))
    return f"""---
title: {yaml_string(stage_title)}
description: {yaml_string(summary)}
outline: [2, 3]
---

# {stage_title}

## {goal_heading}

{goal}

{intro}

{table_header}
|---|---|
{chr(10).join(rows)}

## {how_heading}

{numbered}
"""


def render_index(lang: str) -> str:
    prefix = "" if lang == "zh" else "/en"
    if lang == "zh":
        title = "交付路线与实施计划"
        summary = "Hearth 的六个交付阶段：从最小完整 MVP 到可长期运行的个人 Agent OS。"
        lead = "这份路线只回答两件事：先做什么，后做什么；每个阶段怎样从可用走到可靠。"
        goal_heading = "总体目标"
        goal = "Hearth 的目标是把个人数字工作变成可靠的任务。路线不从架构模块出发，而从用户能完成的事情出发：先交付一个最小完整产品，再逐步扩大工作范围、主动性、记忆和多设备能力。"
        table_heading = "六个阶段"
        table_header = "| 阶段 | 目标 | 完成后得到什么 |"
        table_intro = "每个阶段都包含四个小阶段，点击阶段名称可以进入详细计划。"
        how_heading = "怎么推进"
        how = [
            "**先窄后宽。** 先把一个任务族做完整，再增加新的信息来源、操作方式和设备。",
            "**先只读后写入，先低风险后高风险。** 每一类外部操作都先观察、再起草、再审批执行。",
            "**每阶段都用真实任务验收。** 不以代码写完或页面做完作为完成标准。",
            "**安全和恢复从第一阶段就有。** 审批、产物、失败恢复、权限边界不放到最后补。",
        ]
        start = "从[第一阶段 · 最小完整 MVP](/delivery/stage-1)开始。"
        stage_title = lambda phase: f"第{CN_NUMBERS[phase['num'] - 1]}阶段 · {phase['zh_title']}"
    else:
        title = "Delivery Route and Implementation Plan"
        summary = "Hearth's six delivery phases, from a minimum complete MVP to a long-running Personal Agent OS."
        lead = "This route answers only two questions: what to build first, and what comes next; and how each phase moves from usable to reliable."
        goal_heading = "Overall goal"
        goal = "Hearth turns personal digital work into reliable tasks. The route starts from what the user can complete, not from architecture modules: deliver the smallest complete product first, then expand work coverage, proactivity, memory, and multi-device use."
        table_heading = "Six phases"
        table_header = "| Phase | Goal | What the user gets |"
        table_intro = "Each phase has four steps. Open a phase name for the detailed plan."
        how_heading = "How to proceed"
        how = [
            "**Narrow before broad.** Complete one task family before adding sources, operation modes, and devices.",
            "**Read-only before writes, low risk before high risk.** Observe first, draft second, and approve execution last.",
            "**Accept every phase with real tasks.** Finished code or finished pages do not count as completion.",
            "**Safety and recovery start in Phase 1.** Approval, artifacts, failure recovery, and permission boundaries are not postponed.",
        ]
        start = "Start with [Phase 1 · Minimum Complete MVP](/en/delivery/stage-1)."
        stage_title = lambda phase: f"Phase {phase['num']} · {phase['en_title']}"

    rows = []
    for phase in PHASES:
        link = f"{prefix}/delivery/{phase['slug']}"
        rows.append(f"| [{stage_title(phase)}]({link}) | {phase[f'{lang}_summary']} | {phase[f'{lang}_outcome']} |")
    how_text = "\n".join(f"{index}. {item}" for index, item in enumerate(how, 1))
    return f"""---
title: {yaml_string(title)}
description: {yaml_string(summary)}
outline: [2, 3]
---

# {title}

<p class="lead">{lead}</p>

## {goal_heading}

{goal}

## {table_heading}

{table_intro}

{table_header}
|---|---|---|
{chr(10).join(rows)}

## {how_heading}

{how_text}

{start}
"""


def render_sidebar() -> str:
    lines = ["export const zhDeliveryStages = ["]
    for phase in PHASES:
        cn_number = CN_NUMBERS[phase["num"] - 1]
        stage_title = f"第{cn_number}阶段 · {phase['zh_title']}"
        lines.append("  {")
        lines.append(f"    text: {json.dumps(stage_title, ensure_ascii=False)},")
        lines.append("    collapsed: true,")
        lines.append("    items: [")
        lines.append(f"      {{ text: \"阶段总览\", link: \"/delivery/{phase['slug']}\" }},")
        for index, module in enumerate(phase["modules"]):
            module_title = f"{module['num']} {module['zh_title']}"
            comma = "," if index < len(phase["modules"]) - 1 else ""
            lines.append(
                f"      {{ text: {json.dumps(module_title, ensure_ascii=False)}, link: \"/delivery/{phase['slug']}/{module['slug']}\" }}{comma}"
            )
        lines.append("    ]")
        lines.append("  },")
    lines.append("]")
    lines.append("")
    lines.append("export const enDeliveryStages = [")
    for phase in PHASES:
        stage_title = f"Phase {phase['num']} · {phase['en_title']}"
        lines.append("  {")
        lines.append(f"    text: {json.dumps(stage_title)},")
        lines.append("    collapsed: true,")
        lines.append("    items: [")
        lines.append(f"      {{ text: \"Phase overview\", link: \"/en/delivery/{phase['slug']}\" }},")
        for index, module in enumerate(phase["modules"]):
            module_title = f"{module['num']} {module['en_title']}"
            comma = "," if index < len(phase["modules"]) - 1 else ""
            lines.append(
                f"      {{ text: {json.dumps(module_title)}, link: \"/en/delivery/{phase['slug']}/{module['slug']}\" }}{comma}"
            )
        lines.append("    ]")
        lines.append("  },")
    lines.append("]")
    return "\n".join(lines) + "\n"


def main() -> None:
    write(DOCS / "delivery" / "index.md", render_index("zh"))
    write(DOCS / "en" / "delivery" / "index.md", render_index("en"))

    for phase in PHASES:
        write(DOCS / "delivery" / f"{phase['slug']}.md", render_stage(phase, "zh"))
        write(DOCS / "en" / "delivery" / f"{phase['slug']}.md", render_stage(phase, "en"))
        for module in phase["modules"]:
            write(
                DOCS / "delivery" / phase["slug"] / f"{module['slug']}.md",
                render_module(phase, module, "zh"),
            )
            write(
                DOCS / "en" / "delivery" / phase["slug"] / f"{module['slug']}.md",
                render_module(phase, module, "en"),
            )

    write(DOCS / ".vitepress" / "delivery-sidebar.mjs", render_sidebar())


if __name__ == "__main__":
    main()
