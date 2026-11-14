import type { RunBudget } from "./types.ts";

export const EXECUTION_MODES = ["quick", "standard", "deep"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const EXECUTION_PROFILES: Record<ExecutionMode, { label: string; budget: RunBudget; instruction: string }> = {
  quick: {
    label: "快速",
    budget: { maxTurns: 8, maxToolCalls: 16, maxTokens: 60_000, maxDurationMs: 5 * 60_000 },
    instruction: "优先使用已有材料和网页正文，围绕用户问题提取要点。避免重复读取同一内容，仅在关键事实缺失时补充读取。尽早生成交付物并调用 finish_task；材料截断或证据不足时在结果中明确说明覆盖范围，不声称完整分析。"
  },
  standard: {
    label: "标准",
    budget: { maxTurns: 24, maxToolCalls: 64, maxTokens: 200_000, maxDurationMs: 15 * 60_000 },
    instruction: "完成必要的材料读取、补充查证和交付检查，避免重复读取已经获得的内容。满足任务要求后及时生成交付物并调用 finish_task，说明无法核实的内容。"
  },
  deep: {
    label: "深入",
    budget: { maxTurns: 60, maxToolCalls: 180, maxTokens: 600_000, maxDurationMs: 40 * 60_000 },
    instruction: "根据任务需要补充来源、交叉验证关键事实并修订结果，优先解决影响结论的证据缺口。达到交付要求后调用 finish_task，无需用满预算；明确标注仍然存在的不确定性。"
  }
};
