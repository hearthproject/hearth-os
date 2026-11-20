import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@hearth/agent-runtime";
import type { SkillService } from "./skills/service.ts";
import type { SkillView } from "@hearth/core";

const MAX_RESOURCE_BYTES = 1_000_000;

export interface SkillToolOptions {
  skills: SkillService;
  taskId?: string | null;
  runId?: string | null;
}

export function createSkillTools(options: SkillToolOptions): AgentTool[] {
  const loadSkill: AgentTool = {
    definition: {
      name: "load_skill",
      description: "Load an installed skill by id or exact name. Returns its instruction prompt and marks it active for this run.",
      parameters: {
        type: "object",
        properties: {
          skill: { type: "string", description: "Skill id or exact name" }
        },
        required: ["skill"],
        additionalProperties: false
      }
    },
    async execute(input, context): Promise<AgentToolResult> {
      const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const query = typeof args.skill === "string" ? args.skill.trim() : "";
      if (!query) throw new Error("请提供 skill id 或名称");
      const skill = resolveSkill(options.skills, query);
      if (!skill) throw new Error(`没有找到 Skill：${query}`);
      const used = options.skills.use(skill.id, {
        taskId: options.taskId ?? null,
        runId: options.runId ?? null,
        note: "native agent loaded the skill"
      });
      activate(context, skill.id);
      return { content: used.prompt };
    }
  };

  const readResource: AgentTool = {
    definition: {
      name: "read_skill_resource",
      description: "Read a text resource (references, scripts, assets list) inside a skill that was loaded in this run.",
      parameters: {
        type: "object",
        properties: {
          skill: { type: "string", description: "Skill id or exact name" },
          path: { type: "string", description: "Path relative to the skill root" }
        },
        required: ["skill", "path"],
        additionalProperties: false
      }
    },
    async execute(input, context): Promise<AgentToolResult> {
      const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const query = typeof args.skill === "string" ? args.skill.trim() : "";
      const resource = typeof args.path === "string" ? args.path.trim() : "";
      if (!query || !resource) throw new Error("请提供 skill 和 path");
      const skill = resolveSkill(options.skills, query);
      if (!skill) throw new Error(`没有找到 Skill：${query}`);
      if (!context.state?.activeSkills?.includes(skill.id)) {
        throw new Error(`Skill 尚未加载：${skill.id}。请先调用 load_skill。`);
      }
      const root = resolve(skill.path);
      const target = resolve(root, resource);
      if (!isInside(root, target)) throw new Error("资源路径超出 Skill 目录");
      if (!existsSync(target)) throw new Error(`资源不存在：${resource}`);
      const stat = statSync(target);
      if (!stat.isFile()) throw new Error(`资源不是文件：${resource}`);
      if (stat.size > MAX_RESOURCE_BYTES) throw new Error(`资源超过 ${MAX_RESOURCE_BYTES} 字节，请读取更小的文件`);
      return { content: readFileSync(target, "utf8") };
    }
  };

  return [loadSkill, readResource];
}

function resolveSkill(service: SkillService, query: string): SkillView | null {
  return service.get(query) ?? service.list().find((skill) => skill.name === query) ?? null;
}

function activate(context: AgentToolContext, id: string): void {
  if (!context.state) return;
  const active = context.state.activeSkills ?? [];
  if (!active.includes(id)) context.state.activeSkills = [...active, id];
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
