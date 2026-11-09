import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type {
  MethodCandidate,
  SkillDocument,
  SkillIndexEntry,
  SkillManifest,
  SkillPackageExport,
  SkillPackageRecord,
  SkillPermissions,
  SkillResourceRef,
  TaskRecord
} from "@hearth/core";
import type { MethodService } from "./methods.ts";
import type { HearthService } from "./service.ts";
import {
  buildSkillIndexEntry,
  classifySkillResource,
  parseSkillDocument,
  renderSkillDocument,
  skillIdFromName,
  SkillPackageError
} from "./skill-package.ts";

const SKILL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export interface SkillPackageServiceOptions {
  rootDir: string;
  clock?: () => Date;
}

export class SkillPackageService {
  private readonly service: HearthService;
  private readonly methods: MethodService;
  private readonly rootDir: string;
  private readonly clock: () => Date;

  constructor(service: HearthService, methods: MethodService, options: SkillPackageServiceOptions) {
    this.service = service;
    this.methods = methods;
    this.rootDir = resolve(options.rootDir);
    this.clock = options.clock ?? (() => new Date());
  }

  get root(): string {
    return this.rootDir;
  }

  list(): SkillIndexEntry[] {
    if (!existsSync(this.rootDir)) return [];
    return readdirSync(this.rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .flatMap((entry) => {
        try {
          return [this.readIndex(entry.name)];
        } catch {
          return [];
        }
      })
      .sort((left, right) =>
        Number(right.pinned) - Number(left.pinned)
        || left.name.localeCompare(right.name)
      );
  }

  readIndex(id: string): SkillIndexEntry {
    const record = this.readRecord(id);
    return buildSkillIndexEntry({
      document: { manifest: record.manifest, body: "", contentHash: record.contentHash },
      status: "adopted",
      pinned: record.manifest.metadata.hearth.pinned,
      id: record.id
    });
  }

  readDocument(id: string): SkillDocument {
    return parseSkillDocument(readFileSync(join(this.skillDir(id), "SKILL.md"), "utf8"));
  }

  readRecord(id: string): SkillPackageExport {
    const dir = this.skillDir(id);
    const raw = JSON.parse(readFileSync(join(dir, "skill.json"), "utf8")) as Partial<SkillPackageRecord>;
    if (raw.schemaVersion !== 1 || raw.id !== id || !raw.manifest || !Array.isArray(raw.sourceTaskIds)) {
      throw new SkillPackageError("SKILL_PACKAGE_INVALID", "skill.json 格式无效", 500);
    }
    return {
      ...(raw as SkillPackageRecord),
      path: dir
    };
  }

  readResources(id: string): SkillResourceRef[] {
    const dir = this.skillDir(id);
    const resources: SkillResourceRef[] = [];
    const visit = (current: string, depth: number): void => {
      if (depth > 5) return;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const fullPath = join(current, entry.name);
        if (entry.isSymbolicLink()) {
          throw new SkillPackageError("SKILL_RESOURCE_SYMLINK", "技能资源不能使用符号链接", 409);
        }
        if (entry.isDirectory()) {
          visit(fullPath, depth + 1);
          continue;
        }
        const path = relative(dir, fullPath).split(sep).join("/");
        if (path === "SKILL.md" || path === "skill.json") continue;
        resources.push({
          path,
          kind: classifySkillResource(path),
          bytes: lstatSync(fullPath).size
        });
      }
    };
    visit(dir, 0);
    return resources.sort((left, right) => left.path.localeCompare(right.path));
  }

  exportMethod(methodId: string): SkillPackageExport {
    const method = this.methods.snapshot().methods.find((item) => item.id === methodId);
    if (!method) throw new SkillPackageError("SKILL_METHOD_NOT_FOUND", "来源方法不存在", 404);
    if (method.status !== "adopted") {
      throw new SkillPackageError("SKILL_METHOD_NOT_ADOPTED", "只有已采纳的方法可以导出为技能包", 409);
    }
    const id = skillSlug(method);
    const manifest = this.manifestForMethod(method, id);
    const body = renderMethodBody(method, manifest);
    const document = parseSkillDocument(renderSkillDocument({
      manifest,
      body,
      contentHash: ""
    }));
    const record: SkillPackageRecord = {
      schemaVersion: 1,
      id,
      methodId: method.id,
      methodVersion: method.version,
      version: manifest.version,
      sourceTaskIds: [...method.sourceTaskIds],
      exportedAt: this.nowIso(),
      contentHash: document.contentHash,
      manifest
    };
    const currentDir = join(this.rootDir, id);
    const existing = this.tryReadRecord(currentDir);
    if (existing && existing.contentHash === record.contentHash && existing.methodVersion === record.methodVersion) {
      return { ...existing, path: currentDir };
    }

    mkdirSync(this.rootDir, { recursive: true });
    const tempDir = resolveInside(this.rootDir, ".tmp-" + id + "-" + randomUUID());
    try {
      this.writePackage(tempDir, document, record);
      if (existing) this.archiveCurrent(currentDir, id, existing);
      if (existsSync(currentDir)) rmSync(currentDir, { recursive: true, force: true });
      renameSync(tempDir, currentDir);
    } catch (error) {
      rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
    return { ...record, path: currentDir };
  }

  private manifestForMethod(method: MethodCandidate, id: string): SkillManifest {
    const tasks = method.sourceTaskIds
      .map((taskId) => this.service.store.getTask(taskId))
      .filter((task): task is TaskRecord => Boolean(task));
    const tools = unique([
      ...intersectionStrings(tasks.map((task) => task.permissions?.tools ?? [])),
      ...toolsFromSteps(method.steps),
      "read_file"
    ]);
    const permissions: SkillPermissions = {
      readRoots: intersectionStrings(tasks.map((task) => task.permissions?.readRoots ?? [])),
      writeRoots: intersectionStrings(tasks.map((task) => task.permissions?.writeRoots ?? [])),
      networkHosts: intersectionStrings(tasks.map((task) => task.networkHosts))
    };
    const originTaskId = method.sourceTaskIds[0] ?? null;
    return {
      name: id,
      description: clip(method.summary, 600),
      version: "1." + Math.max(0, method.version - 1) + ".0",
      platforms: ["windows", "macos", "linux"],
      tools,
      permissions,
      metadata: {
        hearth: {
          category: method.templateId ? "template-" + method.templateId.toLowerCase() : "general",
          originTaskId,
          originHash: sha256(JSON.stringify({
            methodId: method.id,
            methodVersion: method.version,
            steps: method.steps,
            sourceTaskIds: method.sourceTaskIds
          })),
          adoptedAt: method.adoptedAt,
          origin: "agent",
          pinned: false
        }
      }
    };
  }

  private writePackage(dir: string, document: SkillDocument, record: SkillPackageRecord): void {
    for (const folder of ["references", "scripts", "templates", "tests"]) {
      mkdirSync(resolveInside(dir, folder), { recursive: true });
    }
    writeFileSync(join(dir, "SKILL.md"), renderSkillDocument(document), "utf8");
    writeFileSync(join(dir, "skill.json"), JSON.stringify(record, null, 2) + "\n", "utf8");
    writeFileSync(join(dir, "references", "README.md"), "# References\n\nAdd supporting notes and citations here.\n", "utf8");
    writeFileSync(join(dir, "scripts", "README.md"), "# Scripts\n\nScripts run only inside the permissions declared in SKILL.md.\n", "utf8");
    writeFileSync(join(dir, "templates", "README.md"), "# Templates\n\nAdd reusable output templates here.\n", "utf8");
    writeFileSync(join(dir, "tests", "README.md"), "# Tests\n\nAdd regression checks for this skill here.\n", "utf8");
  }

  private archiveCurrent(currentDir: string, id: string, existing: SkillPackageExport): void {
    const archiveRoot = resolveInside(this.rootDir, ".versions", id);
    mkdirSync(archiveRoot, { recursive: true });
    const suffix = existing.contentHash.replace(/^sha256:/, "").slice(0, 12);
    const archiveDir = resolveInside(archiveRoot, `${existing.version}-${suffix}`);
    if (existsSync(archiveDir)) rmSync(archiveDir, { recursive: true, force: true });
    renameSync(currentDir, archiveDir);
    if (!existsSync(join(archiveDir, "skill.json"))) {
      throw new SkillPackageError("SKILL_VERSION_ARCHIVE_FAILED", "无法保留旧版本技能包：" + id, 500);
    }
  }

  private tryReadRecord(dir: string): SkillPackageExport | null {
    try {
      return this.readRecord(basename(dir));
    } catch {
      return null;
    }
  }

  private skillDir(id: string): string {
    if (!SKILL_ID_PATTERN.test(id)) {
      throw new SkillPackageError("SKILL_ID_INVALID", "技能 ID 无效", 400);
    }
    return resolveInside(this.rootDir, id);
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }
}

export function skillSlug(method: Pick<MethodCandidate, "id" | "name">): string {
  const normalized = method.name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 58);
  const candidate = normalized || "method-" + method.id.replace(/[^a-z0-9]/gi, "").slice(0, 12).toLowerCase();
  return skillIdFromName(/^[a-z]/.test(candidate) ? candidate : "skill-" + candidate);
}

function renderMethodBody(method: MethodCandidate, manifest: SkillManifest): string {
  const tools = manifest.tools.length ? manifest.tools.join("、") : "read_file";
  const guardrails = method.guardrails.length ? method.guardrails : ["外部写入前保留审批门"];
  const permissions = [
    "读取根目录：" + (manifest.permissions.readRoots.join("、") || "无"),
    "写入根目录：" + (manifest.permissions.writeRoots.join("、") || "无"),
    "网络主机：" + (manifest.permissions.networkHosts.join("、") || "无")
  ];
  return [
    "# " + method.name + " Skill",
    "",
    "## When to Use",
    "",
    method.applicability,
    "",
    "## Prerequisites",
    "",
    "- 可用工具：" + tools,
    ...permissions.map((line) => "- " + line),
    "",
    "## Procedure",
    "",
    ...method.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Quick Reference",
    "",
    "- 来源任务：" + method.sourceTaskIds.join("、"),
    "- 模板：" + (method.templateId ?? "无"),
    "- 方法版本：" + method.version,
    "",
    "## Pitfalls",
    "",
    ...guardrails.map((guardrail) => "- " + guardrail),
    "",
    "## Verification",
    "",
    "- 产物与来源任务的要求一致。",
    "- 外部动作保留原有审批和 effect 回执。",
    "- 失败时保留证据，不把未验证结果标记为完成。",
    ""
  ].join("\n");
}

function toolsFromSteps(steps: string[]): string[] {
  const tools: string[] = [];
  for (const step of steps) {
    const marker = step.indexOf("：");
    if (marker < 0 || !step.includes("动作")) continue;
    for (const item of step.slice(marker + 1).split("→")) {
      const tool = item.trim();
      if (/^[a-z][a-z0-9_]{2,60}$/.test(tool)) tools.push(tool);
    }
  }
  return tools;
}

function intersectionStrings(values: string[][]): string[] {
  if (values.length === 0) return [];
  const sets = values.map((items) => new Set(items));
  const first = values[0] ?? [];
  return [...new Set(first)].filter((item) => sets.every((set) => set.has(item))).sort();
}

function resolveInside(root: string, ...segments: string[]): string {
  const base = resolve(root);
  const target = resolve(base, ...segments);
  const relation = relative(base, target);
  if (relation.startsWith("..") || resolve(base, relation) !== target) {
    throw new SkillPackageError("SKILL_PATH_ESCAPE", "技能路径超出允许目录", 409);
  }
  return target;
}

function sha256(text: string): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex");
}

function clip(text: string, max: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : compact.slice(0, max - 1) + "…";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
