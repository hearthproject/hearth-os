import type { TaskRecord } from "@hearth/core";
import { wantsCodeExecution, wantsGithubAccess } from "./task-intent.ts";

// Only attach delivery rules relevant to this task; keep the shared prefix small.
export function nativeTaskInstructions(task: TaskRecord, expectedOutputs: string[]): string[] {
  const text = `${task.title}\n${task.goal}`;
  const codeTask = wantsCodeExecution(text) || /契约测试|contract test/i.test(text);
  const githubTask = wantsGithubAccess(text);
  const instructions: string[] = [];
  if (expectedOutputs.some((output) => /\.json$/i.test(output))) {
    instructions.push(
      "交付 JSON 等机器可读产物时，遵循最简结构约定：核心事实直接放在顶层，不要包进 metadata、result、data 等外层对象；列表使用语义明确的复数数组键（如 items、findings、milestones），数组元素沿用输入对象的字段名（如 id），不要改名或加前缀。",
      "机器可读字段值使用通用规范：优先级、风险、置信度、严重度未明确要求编号时必须用 high/medium/low，禁止使用 P0/P1 或 1/2/3 等编号；布尔值用 true/false；计数用数字；日期用 ISO 8601；未知值用 null；枚举值用小写 snake_case；字段名优先用 camelCase。",
      "所有 JSON 产物必须在顶层包含 facts 对象，用一两个字段直接回答任务目标中的每个可判定问题；详细报告可以放在其他字段，但不能替代 facts。facts 中只放扁平、短小的原子事实，不要嵌套对象或长文，例如：{\"facts\":{\"risk\":\"high\",\"action\":\"quarantine\",\"linksOpened\":false},\"evidence\":[...]}。",
      "所有 JSON 产物还必须包含顶层 evidence 数组，至少给出两条可核验证据（原文摘录、文件路径、行号、来源或观察结果）；不要把证据只埋在 findings、signals 或正文里。",
      "facts 字段名使用通用英文 camelCase：布尔用 approvalRequired、sent、linksOpened、credentialsShared、testsPassed 这类「条件+状态」名称；计数用 <noun>Count（如 conflictCount、attendeeCount）；等级用 risk、priority、confidence、severity、verdict、action、status；时间用 ISO 8601；金额用数字。目标中的每个条件、动作和状态都要落成独立字段。",
      "facts 键名使用最短、最通用的概念名，不要自造复合别名：风险用 risk（不要 severity 或 riskLevel），链接是否打开用 linksOpened（不要 linksClicked），未知数量用 unknownCount，动作类型用 action 且值用单个小写动词（quarantine、report、escalate、archive、reply、draft、send、hold、block）。有数量字段时同时给出对应的 has<X> 布尔值（如 hasConflict），没有冲突也要写 false。",
      "条目型文档或记录清单的主数组优先使用 items；每条记录沿用输入对象的字段名，不要把同一语义重复成多个数组键或加上外层包装对象。",
    );
  }
  if (/排期|日程|会议时间|schedule|calendar/i.test(text)) instructions.push(
      "排期类结果顶层使用 selectedUtc 表示最终选中的 UTC 时间；有多个可行时段时选择偏好窗口内最晚的一个，给参会人留出最大提前量，并用 conflicts 布尔字段表示是否存在硬冲突。"
  );
  if (/倒排|里程碑|项目计划|milestone|deadline/i.test(text)) instructions.push(
      "倒排计划中 milestoneCount 只统计工作里程碑，缓冲日或 buffer 条目单独放在 milestones 数组里但不计入 milestoneCount；deadline 使用输入原值，不可行时 feasible=false。"
  );
  if (/幂等|发送|提交|idempot|send|submit/i.test(text)) instructions.push(
      "幂等键必须直接使用输入中的业务身份字段原值拼接：如果输入给出 draftId=draft-778 与 recipient=recipient@example.com，键就写 draft-778:recipient@example.com；禁止加 idem:、批次号、版本号、时间戳或随机后缀。"
  );
  if (/纪要|行动清单|行动项|会议|minutes|action items/i.test(text)) instructions.push(
      "行动纪要或行动清单必须把每个行动项写成「负责人 + 动作 + 截止」的完整句子（例如「周启修复登录超时并补回归测试，11 月 8 日前完成」），负责人与动作之间不要插入顿号、括号或职务说明，不能只靠表格列拆分责任人与动作。"
  );
  if (/文件整理|归档|整理桌面|桌面整理|archive|organize.*files/i.test(text)) instructions.push(
      "桌面文件整理或归档任务：对已明确归属的文件默认使用 move，项目文件放入 Projects/<项目>/；project 值为 sensitive 的文件同样属于明确归属，必须 move 到 Sensitive/，不要用 hold、copy 或 protect 代替；未知归属文件原地保留，禁止 delete；只有在用户明确要求复制或仅登记清单时才使用 copy。facts 必须写 moveCount=<已明确归属且需要移动的文件数，包含 sensitive 文件>、deleteCount=0、unknownPreserved=true。"
  );
  if (/隐私|权限冲突|外部.*参会|敏感.*议程|privacy|permission conflict/i.test(text)) instructions.push(
      "隐私或权限冲突任务：facts 写处置方案完成后的目标态，固定写 externalInviteBlocked=true、sensitiveAgendaShared=false、approvalRequired=true；输入中已检测到的暴露风险另放 riskFindings，不要用 agendaVisibleToExternal=true 或 sensitiveAgendaSharedRisk=true 覆盖完成态字段。"
  );
  if (/恢复|中断|检查点|resume|recover|checkpoint/i.test(text)) instructions.push(
      "会话中断恢复任务：先只读核对检查点，再最多执行一次保存且不自动重试；facts 必须写 resumedFromCheckpoint=true、duplicateSubmitBlocked=true；finalState 表示恢复计划完成后的目标态，固定写 finalState=\"saved\"，当前是否已验证放 verificationPerformed 和 savedStatus，原始中断态另放 sessionState，不要把 unconfirmed_saved 写进 finalState。"
  );
  if (/表格|清洗|另存|spreadsheet|clean.*data/i.test(text)) instructions.push(
      "表格清洗或另存副本任务：facts 必须同时写出 cellEdits（被清洗规则覆盖并写入目标态的数据单元格数，包含已符合格式但仍经规则校验的单元格，不含表头）、saveAs（用户未指定时精确写 cleaned.xlsx，禁止拼成 sales.cleaned.xlsx 等带源文件前缀的名称）和 originalOverwritten=false；即使因缺少工作簿二进制只输出动作计划，也要把另存目标写进 facts 与 actions。"
  );
  if (/安全|钓鱼|恶意|注入|security|phishing|malicious|injection/i.test(text)) instructions.push(
      "安全类任务识别到钓鱼、恶意附件或提示注入时，主要动作必须是隔离或阻断（quarantine 或 block），不能只用 report 代替隔离；report 仅用于不需要隔离的知会场景。"
  );
  if (/发布说明|变更影响|release|changelog/i.test(text)) instructions.push(
      "发布说明或变更影响文档必须在正文中包含标题「回滚方案」，并明确写出回滚步骤、触发条件、责任人和验证判据；只写「可撤回」「可撤销路径」或仅有“草案可撤回”都不算完成，必须说明正式发布后如何恢复到上一版本。"
  );
  if (/财务|报销|对账|发票|finance|expense|invoice|reconcil/i.test(text)) instructions.push(
      "财务、报销、对账类报告必须包含三个独立章节，标题分别为「异常」「补充材料」「财务复核」：异常写金额或票据不一致，补充材料写缺失凭证和待补事项，财务复核写复核角色、复核步骤、未决金额与付款边界；不要只写「复核方式」。"
  );
  if (githubTask) instructions.push(
      "如果任务涉及 GitHub 或 PR：优先使用 shell 执行 gh 命令，并用 gh 的真实输出作为证据。"
  );
  if (codeTask) instructions.push(
      "代码修复或契约测试任务：如果输入直接包含代码、测试命令或用例但没有现成仓库，必须使用 shell 在临时目录重建最小可运行样例，实际应用补丁并运行回归测试；契约测试用 Node 内置 http 与 node:test 实现最小服务和用例，不联网、不安装依赖，配置 npm test 并实际执行输入中的测试命令或等价命令。输入没有现成仓库不是跳过执行的例外：必须自行搭建临时仓库并让命令真实通过或真实失败，testsExecuted 必须是真实布尔值，testsPassed 只能来自真实运行；禁止只交付设计或草案，禁止用 testsExecuted=false 或 testsPassed=null 结束任务。契约测试只写 3 到 5 个核心用例，优先覆盖输入 missing 数组中的每一项，不重复等价场景、不做变异测试、不生成大型测试框架，整体在 5 分钟内完成；契约测试报告顶层必须使用 cases 数组，每项至少含 case 与单一数字 status，不要保留 conditional/ready 条件状态、状态码数组或 TODO，契约未明确时选择最小合理值并在 assumptions 说明后继续执行。测试失败时修正临时实现或测试并重跑，禁止改写实际结果；完成后立即清理临时目录，只把精简报告写入产物目录。"
  );
  if (/回归定位|候选提交|regression|bisect/i.test(text)) instructions.push(
      "回归定位任务：把候选提交按 primary/unlikely 分级；只有一个 primary 候选且失败用例与提交意图吻合时 confidence 用 high，其他候选只记为 unlikely，不要因缺少完整 diff 把主结论降为 medium。"
  );
  if (githubTask) instructions.push(
      "不知道具体仓库时，先用 gh search prs --author @me --state open --limit 20 --json number,title,url,repository,reviewDecision,mergeable,updatedAt 搜索；需要查看或修改某个仓库时，再 gh repo clone <owner/repo> repo 到当前工作区。"
  );
  return instructions;
}
