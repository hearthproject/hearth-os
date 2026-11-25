import type { TaskRecord } from "@hearth/core";
import { wantsCodeExecution, wantsGithubAccess } from "./task-intent.ts";

// Product prompts carry portable execution rules only. Deterministic evaluation
// cases and their expected fields belong in hearth-eval fixtures.
export function nativeTaskInstructions(task: TaskRecord, expectedOutputs: string[]): string[] {
  const text = `${task.title}
${task.goal}`;
  const instructions: string[] = [];
  if (expectedOutputs.some((output) => /\.json$/i.test(output))) {
    instructions.push(
      "机器可读产物优先遵守用户给定的字段名、类型和结构，不要擅自改名、加前缀或包一层通用 result/data/metadata。",
      "用户没有给出结构时，只在顶层放完成任务所需的最少事实和证据，并使用清晰的英文 camelCase 字段名。"
    );
  }
  if (wantsGithubAccess(text)) {
    instructions.push("涉及 GitHub 时优先使用 gh 命令，并以命令的真实输出作为证据。");
  }
  if (wantsCodeExecution(text)) {
    instructions.push("涉及代码时实际修改并运行用户指定或项目已有的检查，不能用设计说明代替执行。");
    instructions.push("输入包含测试命令时应运行该命令。只有仓库不存在且用户要求验证最小行为时，才在临时目录重建最小可运行环境。");
  }
  return instructions;
}
