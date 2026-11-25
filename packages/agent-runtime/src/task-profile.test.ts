import { describe, expect, it } from "vitest";
import { TASK_PROFILES, resolveTaskProfile } from "./harness/task-profile.ts";
import { toolCallDefinition, toolSearchDefinition } from "./harness/tool-catalog.ts";
import { createBuiltinTools } from "./tools.ts";
import type { TaskRecord } from "@hearth/core";

function task(title: string, goal = ""): TaskRecord {
  return {
    id: "task-1",
    templateId: null,
    title,
    goal,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deadline: null,
    inputs: [],
    networkHosts: [],
    outputDir: "out",
    currentRunId: null,
    nextAction: null,
    error: null
  };
}

describe("task profiles", () => {
  it("selects coding before every other profile", () => {
    expect(resolveTaskProfile({ task: task("实现网页"), coding: true, screenshot: true, research: true }).id).toBe("coding");
  });

  it("routes research, office and desktop work to different budgets", () => {
    expect(resolveTaskProfile({ task: task("调研 AI 芯片市场"), coding: false, screenshot: false, research: true }).id).toBe("research");
    expect(resolveTaskProfile({ task: task("整理成 Excel 并输出 Word 报告"), coding: false, screenshot: false, research: false }).id).toBe("office");
    expect(resolveTaskProfile({ task: task("打开浏览器截图"), coding: false, screenshot: false, research: false }).id).toBe("desktop");
    expect(resolveTaskProfile({ task: task("普通问答"), coding: false, screenshot: false, research: false }).id).toBe("general");
  });

  it("uses bounded timeouts and parallelism per profile", () => {
    expect(TASK_PROFILES.coding).toMatchObject({ toolTimeoutMs: 600_000, maxParallelTools: 4 });
    expect(TASK_PROFILES.research).toMatchObject({ toolTimeoutMs: 300_000, maxParallelTools: 4 });
    expect(TASK_PROFILES.general).toMatchObject({ toolTimeoutMs: 120_000, maxParallelTools: 1 });
  });

  it("keeps high-frequency profile tools small and deferrable", () => {
    expect(TASK_PROFILES.coding.directTools.length).toBeLessThanOrEqual(18);
    expect(TASK_PROFILES.general.directTools.length).toBeLessThanOrEqual(15);
    for (const profile of Object.values(TASK_PROFILES)) {
      expect(profile.deferRemaining).toBe(true);
      expect(new Set(profile.directTools).size).toBe(profile.directTools.length);
    }
  });

  it("reduces the coding tool schema payload by at least 25 percent", () => {
    const definitions = createBuiltinTools().map((tool) => tool.definition);
    const directNames = new Set(TASK_PROFILES.coding.directTools);
    const direct = definitions.filter((definition) => directNames.has(definition.name));
    const hiddenCount = definitions.length - direct.length;
    const initialPayload = [...direct, toolSearchDefinition(hiddenCount), toolCallDefinition()];
    const fullSize = JSON.stringify(definitions).length;
    const initialSize = JSON.stringify(initialPayload).length;
    expect(direct.length).toBe(18);
    expect(hiddenCount).toBeGreaterThan(0);
    expect(initialSize / fullSize).toBeLessThanOrEqual(0.75);
  });
});
