import type { RunBudget } from "./types.ts";

export const EXECUTION_MODES = ["quick", "standard", "deep"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

// 保留该常量给显式设置上限的调用方使用；默认执行不再设置任何预算。
export const NATIVE_TOKEN_CEILING = 600_000_000;

export const EXECUTION_PROFILES: Record<ExecutionMode, { label: string; budget: RunBudget; instruction: string }> = {
  quick: {
    label: "快速",
    budget: { maxTurns: 80, maxToolCalls: 120, maxTokens: 1_200_000, maxDurationMs: 60 * 60 * 1_000 },
    instruction: "快速模式：简单拟稿直接给出一份短稿，补充信息只做局部修订，不生成来源索引或自查报告；不为了润色重复读写。优先使用已有材料和网页正文，围绕用户问题提取要点。避免重复读取同一内容，仅在关键事实缺失时补充读取。尽早生成交付物并调用 finish_task；材料截断或证据不足时在结果中明确说明覆盖范围，不声称完整分析。"
  },
  standard: {
    label: "标准",
    budget: { maxTurns: 200, maxToolCalls: 300, maxTokens: 3_000_000, maxDurationMs: 4 * 60 * 60 * 1_000 },
    instruction: "完成必要的材料读取、补充查证和交付检查，避免重复读取已经获得的内容。满足任务要求后及时生成交付物并调用 finish_task，说明无法核实的内容。"
  },
  deep: {
    label: "深入",
    budget: { maxTurns: 500, maxToolCalls: 1_000, maxTokens: 8_000_000, maxDurationMs: 12 * 60 * 60 * 1_000 },
    instruction: "根据任务需要补充来源、交叉验证关键事实并修订结果，优先解决影响结论的证据缺口。达到交付要求后调用 finish_task，无需用满预算；明确标注仍然存在的不确定性。"
  }
};
