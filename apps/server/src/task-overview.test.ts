import { describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "@hearth/core";
import type { ModelSettings } from "./model-settings.ts";
import { TaskOverviewService } from "./task-overview.ts";

const task = { id: "overview-test", title: "分析报销", goal: "核对收据并整理差异", status: "queued" } as TaskRecord;
const settings = { model: "test", apiKey: "test", baseUrl: "https://example.com", protocol: "openai-chat" } as ModelSettings;
function cache() {
  const values = new Map<string, string>();
  return { getMeta: (key: string) => values.get(key) ?? null, setMeta: (key: string, value: string) => { values.set(key, value); } };
}

describe("task overview", () => {
  it("deduplicates concurrent requests and reuses persisted summaries across instances", async () => {
    const store = cache();
    const complete = vi.fn(async () => ({ content: "核对报销收据并汇总差异，任务尚未开始。", usage: { inputTokens: 30, outputTokens: 20 } }));
    const service = new TaskOverviewService(store, () => settings, complete);
    const [first, second] = await Promise.all([service.get(task), service.get(task)]);
    expect(first).toEqual(second);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(await new TaskOverviewService(store, () => settings, complete).get(task)).toEqual(first);
    expect(complete).toHaveBeenCalledTimes(1);
    await service.get({ ...task, goal: "补充核对税额" });
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it("reuses completed results without calling a model", async () => {
    const complete = vi.fn();
    const service = new TaskOverviewService(cache(), () => settings, complete);
    expect(await service.get({ ...task, status: "completed", resultSummary: "发现两笔重复报销。" })).toEqual({ summary: "发现两笔重复报销。" });
    expect(complete).not.toHaveBeenCalled();
  });
  it("does not cache failures or substitute the original input", async () => {
    const complete = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce({ content: "任务摘要", usage: null });
    const service = new TaskOverviewService(cache(), () => settings, complete);
    await expect(service.get(task)).rejects.toThrow("unavailable");
    expect(await service.get(task)).toEqual({ summary: "任务摘要" });
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
