import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@hearth/agent-runtime";
import type { SkillService } from "./skills/service.ts";
import { discoverSkillSources } from "./skills/discovery.ts";
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

  const searchSkills: AgentTool = {
    definition: {
      name: "search_skills",
      description: "Search installed skills and GitHub for a skill by plain-language name. Use this before asking the user for a repository; it discovers repos that contain SKILL.md.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Skill name or short intent, for example grill-me, pdf, browser automation" }
        },
        required: ["query"],
        additionalProperties: false
      }
    },
    async execute(input): Promise<AgentToolResult> {
      const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) throw new Error("请提供要搜索的 Skill 名称或用途");
      const installed = options.skills.list().filter((skill) =>
        matchesQuery(skill.name, query) || matchesQuery(skill.manifest.description ?? "", query)
      );
      const discovered = installed.length > 0 ? [] : await discoverSkillSources(query);
      if (installed.length === 0 && discovered.length === 0) {
        return {
          content: `没有找到与“${query}”匹配的 Skill。已尝试 GitHub 仓库搜索；可以换一个更短的关键词后重试，不要要求用户提供仓库地址。`,
          summary: `未找到 Skill：${query}`,
          isError: true
        };
      }
      return {
        content: [
          installed.length > 0 ? `已安装：\n${installed.map((skill) => `- ${skill.name} (${skill.id})`).join("\n")}` : "",
          discovered.length > 0
            ? `GitHub 候选：\n${discovered.map((item, index) =>
                `${index + 1}. ${item.repo}${item.skillPath ? ` · ${item.skillPath}` : ""}${item.description ? ` — ${item.description.slice(0, 160)}` : ""}\n   source: ${item.source}`
              ).join("\n")}`
            : "",
          "安装时直接调用 install_skill；如果给了多个候选，按顺序尝试，不要先问用户要地址。"
        ].filter(Boolean).join("\n\n"),
        summary: `找到 ${installed.length + discovered.length} 个候选`
      };
    }
  };

  const installSkill: AgentTool = {
    definition: {
      name: "install_skill",
      description: "Install a skill from a GitHub URL, local directory, or a skill name. Given a name it searches GitHub for a repo containing SKILL.md and installs the first valid match. Do not ask the user for a repository first.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "GitHub URL, local directory, or skill name/query" },
          ref: { type: "string", description: "Optional git ref" },
          path: { type: "string", description: "Optional path inside the repository" },
          name: { type: "string", description: "Optional installed skill name override" }
        },
        required: ["source"],
        additionalProperties: false
      }
    },
    async execute(input): Promise<AgentToolResult> {
      const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const source = typeof args.source === "string" ? args.source.trim() : "";
      if (!source) throw new Error("请提供 GitHub 地址、本地目录或 Skill 名称");
      const ref = typeof args.ref === "string" && args.ref.trim() ? args.ref.trim() : null;
      const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : null;
      const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : null;
      const isLocation = /^https?:\/\//i.test(source) || /^file:\/\//i.test(source)
        || source.includes("/") || source.includes("\\") || existsSync(source);
      const attempts = isLocation
        ? [{ source, ref, path }]
        : (await discoverSkillSources(source)).map((item) => ({ source: item.source, ref: item.ref, path: item.skillPath }));
      if (attempts.length === 0) {
        throw new Error(`没有找到包含 SKILL.md 的 GitHub 仓库：${source}`);
      }
      const errors: string[] = [];
      for (const attempt of attempts.slice(0, 5)) {
        try {
          const installed = await options.skills.install({
            source: attempt.source,
            ...(attempt.ref ? { ref: attempt.ref } : {}),
            ...(attempt.path ? { path: attempt.path } : {}),
            ...(name ? { name } : {})
          });
          return {
            content: `已安装 Skill：${installed.skill.name} (${installed.skill.id})，来源：${attempt.source}`,
            summary: `已安装 ${installed.skill.name}`
          };
        } catch (error) {
          errors.push(`${attempt.source}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      throw new Error(`安装失败：\n${errors.join("\n")}`);
    }
  };

  return [loadSkill, readResource, searchSkills, installSkill];
}

function matchesQuery(text: string, query: string): boolean {
  const normalizedText = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((part) => normalizedText.includes(part));
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
