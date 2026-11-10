import type {
  MemoryConsolidationGroup,
  MemoryConsolidationRun,
  MemoryConsolidationSource,
  MemoryKind,
  MemoryRecord
} from "@hearth/core";

export interface ConsolidationPlanOptions {
  scope?: string | undefined;
  minClusterSize?: number | undefined;
  maxGroups?: number | undefined;
  now?: Date;
}

export interface ConsolidationPlan {
  groups: MemoryConsolidationGroup[];
  sources: MemoryConsolidationSource[];
  skipped: Array<{ memoryId: string; reason: string }>;
}

export function planMemoryConsolidation(
  memories: MemoryRecord[],
  options: ConsolidationPlanOptions = {}
): ConsolidationPlan {
  const now = (options.now ?? new Date()).getTime();
  const minClusterSize = Math.max(2, options.minClusterSize ?? 2);
  const maxGroups = Math.max(1, options.maxGroups ?? 10);
  const scope = options.scope?.trim() || null;
  const eligible: MemoryRecord[] = [];
  const skipped: Array<{ memoryId: string; reason: string }> = [];
  for (const memory of memories) {
    const reason = consolidationExclusion(memory, scope, now);
    if (reason) skipped.push({ memoryId: memory.id, reason });
    else eligible.push(memory);
  }

  const buckets = new Map<string, MemoryRecord[]>();
  for (const memory of eligible) {
    const key = memory.scope + "\u0000" + (memory.supersessionKey ?? memory.subjectKey);
    const bucket = buckets.get(key) ?? [];
    bucket.push(memory);
    buckets.set(key, bucket);
  }

  const groups: MemoryConsolidationGroup[] = [];
  for (const [key, bucket] of buckets) {
    if (bucket.length < minClusterSize) {
      for (const memory of bucket) skipped.push({ memoryId: memory.id, reason: "同主题记录不足 " + minClusterSize + " 条" });
      continue;
    }
    const ordered = bucket.slice().sort((left, right) => right.importance - left.importance
      || right.recallCount - left.recallCount
      || right.updatedAt.localeCompare(left.updatedAt));
    const first = ordered[0]!;
    const conflicts = conflictingContents(ordered);
    const supersessionKey = first.supersessionKey ?? first.subjectKey;
    groups.push({
      id: "consolidate:" + key.replace("\u0000", ":"),
      kind: dominantKind(ordered),
      supersessionKey,
      subjectKey: first.subjectKey,
      scope: first.scope,
      sourceMemoryIds: ordered.map((memory) => memory.id),
      proposedContent: conflicts.length > 0 ? first.content : longestContent(ordered),
      score: consolidationScore(ordered),
      reasons: consolidationReasons(ordered),
      conflicts
    });
  }

  groups.sort((left, right) => right.score - left.score || right.sourceMemoryIds.length - left.sourceMemoryIds.length);
  const selected = groups.slice(0, maxGroups);
  const selectedIds = new Set(selected.flatMap((group) => group.sourceMemoryIds));
  const selectedSources = eligible
    .filter((memory) => selectedIds.has(memory.id))
    .map(sourceSnapshot);
  return { groups: selected, sources: selectedSources, skipped };
}

export function validateConsolidationGroup(group: MemoryConsolidationGroup): string[] {
  const errors: string[] = [];
  if (group.conflicts.length > 0) errors.push("同主题内容存在冲突，必须人工确认");
  if (!group.proposedContent.trim()) errors.push("巩固内容为空");
  if (group.proposedContent.length > 2000) errors.push("巩固内容超过 2000 字");
  if (group.sourceMemoryIds.length < 2) errors.push("巩固至少需要两条来源记忆");
  if (new Set(group.sourceMemoryIds).size !== group.sourceMemoryIds.length) errors.push("来源记忆重复");
  return errors;
}

export function consolidationReport(run: MemoryConsolidationRun): string {
  const lines = [
    "# 记忆巩固报告",
    "",
    "- 状态：" + run.status,
    "- 模式：" + (run.dryRun ? "dry-run" : "apply"),
    "- 范围：" + (run.scope ?? "全部"),
    "- 分组：" + run.groups.length,
    "- 应用：" + run.appliedMemoryIds.length,
    "- 跳过：" + run.skipped.length
  ];
  for (const group of run.groups) {
    lines.push("", "## " + group.subjectKey, "- 分数：" + group.score.toFixed(2),
      "- 来源：" + group.sourceMemoryIds.length + " 条",
      "- 原因：" + group.reasons.join("；"),
      "- 冲突：" + (group.conflicts.length > 0 ? group.conflicts.length + " 个，未自动覆盖" : "无"),
      "- 候选：" + group.proposedContent);
  }
  if (run.error) lines.push("", "## 错误", run.error);
  return lines.join("\n");
}

function consolidationExclusion(memory: MemoryRecord, scope: string | null, now: number): string | null {
  if (memory.status !== "active") return "状态不是 active";
  if (memory.tier !== "episodic") return "不是 episodic 记忆";
  if (!memory.allowRecall) return "allowRecall 已关闭";
  if (memory.taint !== "clean") return "taint 不是 clean";
  if (memory.originClass === "untrusted") return "来源为 untrusted";
  if (memory.trust === "none") return "信任等级为 none";
  if (memory.sensitivity === "secret") return "secret 不参与巩固";
  if (scope && memory.scope !== scope && memory.scope !== "global") return "不在巩固 scope 内";
  if (memory.validUntil && Date.parse(memory.validUntil) <= now) return "已过期";
  if (memory.expiresAt && Date.parse(memory.expiresAt) <= now) return "已过期";
  return null;
}

function conflictingContents(memories: MemoryRecord[]): string[] {
  const unique = [...new Map(memories.map((memory) => [normalize(memory.content), memory.content])).values()];
  if (unique.length <= 1) return [];
  const normalized = unique.map(normalize);
  for (let left = 0; left < normalized.length; left += 1) {
    for (let right = left + 1; right < normalized.length; right += 1) {
      const a = normalized[left]!;
      const b = normalized[right]!;
      if (!a.includes(b) && !b.includes(a)) return unique;
    }
  }
  return [];
}

function longestContent(memories: MemoryRecord[]): string {
  return memories.map((memory) => memory.content)
    .sort((left, right) => right.length - left.length)[0] ?? "";
}

function dominantKind(memories: MemoryRecord[]): MemoryKind {
  const counts = new Map<MemoryKind, number>();
  for (const memory of memories) counts.set(memory.kind, (counts.get(memory.kind) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "experience";
}

function consolidationScore(memories: MemoryRecord[]): number {
  const importance = memories.reduce((sum, memory) => sum + memory.importance, 0) / memories.length;
  const confidence = memories.reduce((sum, memory) => sum + confidenceScore(memory.confidence), 0) / memories.length;
  const trust = memories.reduce((sum, memory) => sum + trustScore(memory.trust), 0) / memories.length;
  const recalls = Math.min(5, memories.reduce((sum, memory) => sum + memory.recallCount, 0)) * 0.1;
  const days = new Set(memories.map((memory) => memory.createdAt.slice(0, 10))).size;
  return importance * 2 + confidence + trust + recalls + Math.min(5, days) * 0.25;
}

function consolidationReasons(memories: MemoryRecord[]): string[] {
  const reasons = ["同主题 " + memories.length + " 条"];
  const days = new Set(memories.map((memory) => memory.createdAt.slice(0, 10))).size;
  if (days > 1) reasons.push("跨 " + days + " 天重复");
  if (memories.some((memory) => memory.recallCount > 0)) reasons.push("曾被召回");
  reasons.push("平均重要性 " + (memories.reduce((sum, memory) => sum + memory.importance, 0) / memories.length).toFixed(2));
  return reasons;
}

function confidenceScore(value: MemoryRecord["confidence"]): number {
  if (value === "high") return 2;
  if (value === "medium") return 1;
  return 0;
}

function trustScore(value: MemoryRecord["trust"]): number {
  if (value === "high") return 2;
  if (value === "medium") return 1;
  if (value === "low") return 0.5;
  return 0;
}

function sourceSnapshot(memory: MemoryRecord): MemoryConsolidationSource {
  return {
    memoryId: memory.id,
    version: memory.version,
    contentHash: memory.contentHash,
    status: memory.status,
    content: memory.content,
    sourceLabel: memory.source.label,
    updatedAt: memory.updatedAt
  };
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
