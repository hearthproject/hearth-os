import type { RunUsage } from "../lib/types.ts";

export function TaskTokens({ usage }: { usage: RunUsage | null }) {
  if (!usage) return <span>未记录</span>;
  return <span className="task-token-values">
    <span>输入 {usage.inputTokens.toLocaleString("zh-CN")}</span>
    <span>输出 {usage.outputTokens.toLocaleString("zh-CN")}</span>
  </span>;
}
