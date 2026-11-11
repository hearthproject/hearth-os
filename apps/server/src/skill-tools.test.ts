import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTool, AgentToolContext } from "@hearth/agent-runtime";
import { HearthStore } from "@hearth/eventlog";
import { MethodService } from "./methods.ts";
import { nativeSystemPrompt } from "./native-executor.ts";
import { HearthService } from "./service.ts";
import { buildNativeSkillIndex, createSkillTools, SKILL_TOOL_NAMES } from "./skill-tools.ts";
import { SkillPackageService } from "./skills.ts";

describe("native skill tools", () => {
  let store: HearthStore;
  let service: HearthService;
  let methods: MethodService;
  let skills: SkillPackageService;
  let root: string;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    service = new HearthService(store);
    methods = new MethodService(service);
    root = mkdtempSync(join(tmpdir(), "hearth-skill-tools-"));
    skills = new SkillPackageService(service, methods, { rootDir: root });
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function adoptedSkill() {
    const source = service.createTask({
      templateId: "T01",
      title: "整理周报",
      permissions: {
        readRoots: [root],
        writeRoots: [root],
        networkHosts: [],
        tools: ["read_file", "write_file"]
      }
    });
    service.updateTask(source.id, { status: "running", nextAction: "执行中" });
    service.updateTask(source.id, { status: "completed", nextAction: "完成" });
    const method = methods.autoLearnFromTask(source.id);
    if (!method) throw new Error("method missing");
    return skills.exportMethod(method.id);
  }

  function task() {
    return service.createTask({
      templateId: "T02",
      title: "按技能执行",
      permissions: {
        readRoots: [root],
        writeRoots: [],
        networkHosts: [],
        tools: ["read_file"]
      }
    });
  }

  function toolsFor(taskId: string, runId = "run_skill_test") {
    return new Map(createSkillTools({ skills, taskId, runId })
      .map((tool) => [tool.definition.name, tool]));
  }

  function context(): AgentToolContext {
    return {
      workspaceRoot: root,
      outDir: root,
      permissions: {
        readRoots: [root],
        writeRoots: [],
        networkHosts: [],
        tools: [...SKILL_TOOL_NAMES]
      },
      signal: new AbortController().signal
    };
  }

  async function run(tool: AgentTool, args: Record<string, unknown>, toolContext = context()) {
    return tool.execute(args, toolContext);
  }

  it("injects only an index and loads the body on demand", async () => {
    const exported = adoptedSkill();
    const currentTask = task();
    const available = skills.agentSkills(currentTask.id);
    const index = buildNativeSkillIndex(available);

    expect(index).toContain(exported.id);
    expect(index).toContain(exported.contentHash);
    expect(index).not.toContain("## Procedure");
    const prompt = nativeSystemPrompt(currentTask, [], index);
    expect(prompt).toContain("## 可加载技能索引");
    expect(prompt).not.toContain("## Procedure");

    const toolContext = context();
    const before = structuredClone(toolContext.permissions);
    const loaded = await run(toolsFor(currentTask.id).get("load_skill")!, { skillId: exported.id }, toolContext);
    expect(loaded.isError).not.toBe(true);
    expect(loaded.content).toContain("## Procedure");
    expect(toolContext.permissions).toEqual(before);
  });

  it("rejects skill content whose registered hash no longer matches", async () => {
    const exported = adoptedSkill();
    const currentTask = task();
    const documentPath = join(exported.path, "SKILL.md");
    writeFileSync(documentPath, readFileSync(documentPath, "utf8") + "\nTampered.\n", "utf8");
    const result = await run(toolsFor(currentTask.id).get("load_skill")!, { skillId: exported.id });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("哈希");
  });

  it("limits resources to listed package paths and records agent usage", async () => {
    const exported = adoptedSkill();
    const currentTask = task();
    writeFileSync(join(exported.path, "references", "notes.md"), "source notes", "utf8");
    const tools = toolsFor(currentTask.id, "run_resource_test");

    const valid = await run(tools.get("read_skill_resource")!, {
      skillId: exported.id,
      path: "references/notes.md"
    });
    expect(valid.isError).not.toBe(true);
    expect(valid.content).toContain("source notes");

    for (const path of ["../escape.md", "/etc/passwd", "C:\\Windows\\win.ini"]) {
      const invalid = await run(tools.get("read_skill_resource")!, { skillId: exported.id, path });
      expect(invalid.isError).toBe(true);
    }

    const usage = store.listSkillUsage(exported.id);
    expect(usage).toContainEqual(expect.objectContaining({
      taskId: currentTask.id,
      runId: "run_resource_test",
      source: "agent",
      status: "completed"
    }));
  });

  it("rejects symlinked resources and truncates oversized text", async () => {
    const exported = adoptedSkill();
    const currentTask = task();
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "secret", "utf8");
    const link = join(exported.path, "references", "linked.md");
    let symlinkCreated = false;
    try {
      symlinkSync(outside, link, "file");
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }
    if (symlinkCreated) {
      const linked = await run(toolsFor(currentTask.id).get("read_skill_resource")!, {
        skillId: exported.id,
        path: "references/linked.md"
      });
      expect(linked.isError).toBe(true);
      rmSync(link, { force: true });
    }

    writeFileSync(join(exported.path, "references", "large.md"), "a".repeat(60_000), "utf8");
    const large = await run(toolsFor(currentTask.id).get("read_skill_resource")!, {
      skillId: exported.id,
      path: "references/large.md"
    });
    expect(large.isError).not.toBe(true);
    expect(large.content).toContain("读取结果已截断");
    expect(large.content.length).toBeLessThan(49_500);
  });
});
