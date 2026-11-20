import type { MemoryRecord } from "./types.ts";

export function isEvaluationMemory(memory: Pick<MemoryRecord, "content">): boolean {
  return /评测运行约束|[\\/]eval-artifacts[\\/]|EXP-\d{8}/i.test(memory.content);
}
