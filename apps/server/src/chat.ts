import { GITHUB_NETWORK_HOSTS, wantsDirectFileRead, wantsGithubAccess, wantsScreenshot, wantsSkillInstall } from "./task-intent.ts";

export type ExecutionCapability = "github" | "desktop-capture";

export interface ExecutionPlan {
  taskKind: "general" | "workspace";
  expectedOutputs: string[];
  capability?: ExecutionCapability;
  networkHosts?: string[];
}

const CODE_HINTS = /(代码|仓库|项目里|这个项目|工程|git|commit|分支|测试|编译|构建|部署|重构|修复|bug|issue|pull request|typescript|javascript|python|npm|pnpm|依赖|数据库迁移|脚本)/i;

/**
 * Metadata only. It configures the workspace and network envelope but never
 * decides whether the selected harness should answer or perform work.
 */
export function planExecution(message: string): ExecutionPlan {
  if (wantsDirectFileRead(message) || wantsSkillInstall(message)) {
    return { taskKind: "general", expectedOutputs: [] };
  }
  if (wantsScreenshot(message)) {
    return {
      taskKind: "general",
      expectedOutputs: ["desktop.png"],
      capability: "desktop-capture"
    };
  }
  if (wantsGithubAccess(message)) {
    return {
      taskKind: "workspace",
      expectedOutputs: [],
      capability: "github",
      networkHosts: [...GITHUB_NETWORK_HOSTS]
    };
  }
  if (CODE_HINTS.test(message)) return { taskKind: "workspace", expectedOutputs: [] };
  return { taskKind: "general", expectedOutputs: [] };
}

export function conversationTitle(message: string): string {
  const clean = message
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:请帮我|麻烦你?|请|帮我|替我|给我|我想|我需要|需要你|能不能|可以帮我|你可以|你能)\s*/u, "")
    .replace(/^[，,。.、:：\s]+/, "")
    .replace(/[。.!！?？\s]+$/u, "");
  if (!clean) return "新对话";
  return clean.length > 24 ? `${clean.slice(0, 24)}…` : clean;
}
