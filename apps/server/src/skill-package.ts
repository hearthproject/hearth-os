import { createHash } from "node:crypto";
import {
  SKILL_ORIGINS,
  SKILL_PLATFORMS,
  type SkillDocument,
  type SkillIndexEntry,
  type SkillManifest,
  type SkillOrigin,
  type SkillPlatform,
  type SkillResourceRef,
  type SkillStatus
} from "@hearth/core";

const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SKILL_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const REQUIRED_SECTIONS = [
  "When to Use",
  "Prerequisites",
  "Procedure",
  "Quick Reference",
  "Pitfalls",
  "Verification"
] as const;

export class SkillPackageError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "SkillPackageError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ParseSkillOptions {
  requireFixedSections?: boolean;
}

export interface SkillIndexInput {
  document: SkillDocument;
  status: SkillStatus;
  pinned?: boolean;
  id?: string;
}

export function parseSkillDocument(text: string, options: ParseSkillOptions = {}): SkillDocument {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new SkillPackageError("SKILL_FRONTMATTER_REQUIRED", "SKILL.md 必须以 YAML frontmatter 开头");
  }
  const metadata = parseYamlSubset(match[1] ?? "");
  const manifest = normalizeManifest(metadata);
  const body = (match[2] ?? "").replace(/^\n+/, "").replace(/\s+$/, "") + "\n";
  if (options.requireFixedSections !== false) validateFixedSections(body, manifest.name);
  return {
    manifest,
    body,
    contentHash: sha256(normalized)
  };
}

export function renderSkillDocument(document: SkillDocument): string {
  const manifest = normalizeManifest(document.manifest as unknown as Record<string, unknown>);
  const body = document.body.replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "") + "\n";
  return [
    "---",
    `name: ${yamlScalar(manifest.name)}`,
    `description: ${yamlScalar(manifest.description)}`,
    `version: ${yamlScalar(manifest.version)}`,
    `platforms: ${yamlArray(manifest.platforms)}`,
    `tools: ${yamlArray(manifest.tools)}`,
    "permissions:",
    `  readRoots: ${yamlArray(manifest.permissions.readRoots)}`,
    `  writeRoots: ${yamlArray(manifest.permissions.writeRoots)}`,
    `  networkHosts: ${yamlArray(manifest.permissions.networkHosts)}`,
    "metadata:",
    "  hearth:",
    `    category: ${yamlScalar(manifest.metadata.hearth.category)}`,
    `    originTaskId: ${manifest.metadata.hearth.originTaskId === null ? "null" : yamlScalar(manifest.metadata.hearth.originTaskId)}`,
    `    originHash: ${manifest.metadata.hearth.originHash === null ? "null" : yamlScalar(manifest.metadata.hearth.originHash)}`,
    `    adoptedAt: ${manifest.metadata.hearth.adoptedAt === null ? "null" : yamlScalar(manifest.metadata.hearth.adoptedAt)}`,
    `    origin: ${yamlScalar(manifest.metadata.hearth.origin)}`,
    `    pinned: ${manifest.metadata.hearth.pinned ? "true" : "false"}`,
    "---",
    body
  ].join("\n");
}

export function skillIdFromName(name: string): string {
  return name.trim().toLowerCase();
}

export function buildSkillIndexEntry(input: SkillIndexInput): SkillIndexEntry {
  const { manifest } = input.document;
  return {
    id: input.id ?? skillIdFromName(manifest.name),
    name: manifest.name,
    description: clipSkillDescription(manifest.description),
    version: manifest.version,
    platforms: [...manifest.platforms],
    tags: unique([manifest.metadata.hearth.category, ...manifest.platforms]),
    category: manifest.metadata.hearth.category,
    status: input.status,
    pinned: input.pinned ?? manifest.metadata.hearth.pinned,
    origin: manifest.metadata.hearth.origin
  };
}

export function buildDailySkillIndex(items: SkillIndexInput[]): SkillIndexEntry[] {
  return items
    .filter((item) => item.status === "adopted")
    .map(buildSkillIndexEntry)
    .sort((left, right) =>
      Number(right.pinned) - Number(left.pinned)
      || left.name.localeCompare(right.name)
      || left.version.localeCompare(right.version)
    );
}

export function buildFullSkillDocument(document: SkillDocument): { manifest: SkillManifest; body: string } {
  return { manifest: structuredClone(document.manifest), body: document.body };
}

export function buildSkillResourceList(resources: SkillResourceRef[]): SkillResourceRef[] {
  return [...resources]
    .map((resource) => ({ ...resource }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function classifySkillResource(path: string): SkillResourceRef["kind"] {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("references/")) return "reference";
  if (normalized.startsWith("scripts/")) return "script";
  if (normalized.startsWith("templates/")) return "template";
  if (normalized.startsWith("tests/")) return "test";
  return "other";
}

export function clipSkillDescription(description: string): string {
  const compact = description.replace(/\s+/g, " ").trim();
  return compact.length <= 60 ? compact : compact.slice(0, 59) + "…";
}

function normalizeManifest(input: Record<string, unknown>): SkillManifest {
  const name = requiredString(input.name, "SKILL_NAME_REQUIRED", "技能缺少 name");
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new SkillPackageError("SKILL_NAME_INVALID", "技能 name 只能使用小写字母、数字和连字符，最长 64 个字符");
  }
  const description = requiredString(input.description, "SKILL_DESCRIPTION_REQUIRED", "技能缺少 description");
  if (description.length > 600) {
    throw new SkillPackageError("SKILL_DESCRIPTION_TOO_LONG", "技能 description 不能超过 600 个字符");
  }
  const version = requiredString(input.version, "SKILL_VERSION_REQUIRED", "技能缺少 version");
  if (!SKILL_VERSION_PATTERN.test(version)) {
    throw new SkillPackageError("SKILL_VERSION_INVALID", "技能 version 必须是语义化版本，例如 1.0.0");
  }

  const platforms = stringArray(input.platforms).map((platform) => {
    if (!SKILL_PLATFORMS.includes(platform as SkillPlatform)) {
      throw new SkillPackageError("SKILL_PLATFORM_INVALID", "不支持的技能平台：" + platform);
    }
    return platform as SkillPlatform;
  });
  if (platforms.length === 0) platforms.push(...SKILL_PLATFORMS);

  const permissions = isRecord(input.permissions) ? input.permissions : {};
  const metadata = isRecord(input.metadata) && isRecord(input.metadata.hearth) ? input.metadata.hearth : {};
  const origin = metadata.origin === undefined ? "agent" : requiredString(metadata.origin, "SKILL_ORIGIN_INVALID", "技能 origin 无效");
  if (!SKILL_ORIGINS.includes(origin as SkillOrigin)) {
    throw new SkillPackageError("SKILL_ORIGIN_INVALID", "不支持的技能来源：" + origin);
  }

  return {
    name,
    description,
    version,
    platforms: unique(platforms),
    tools: unique(stringArray(input.tools)),
    permissions: {
      readRoots: unique(stringArray(permissions.readRoots)),
      writeRoots: unique(stringArray(permissions.writeRoots)),
      networkHosts: unique(stringArray(permissions.networkHosts))
    },
    metadata: {
      hearth: {
        category: optionalString(metadata.category) || "general",
        originTaskId: optionalString(metadata.originTaskId),
        originHash: optionalString(metadata.originHash),
        adoptedAt: optionalString(metadata.adoptedAt),
        origin: origin as SkillOrigin,
        pinned: metadata.pinned === true || metadata.pinned === "true"
      }
    }
  };
}

function validateFixedSections(body: string, name: string): void {
  const lines = body.split("\n");
  const h1 = lines.find((line) => line.startsWith("# "));
  if (!h1) throw new SkillPackageError("SKILL_TITLE_REQUIRED", "SKILL.md 需要一级标题");
  const title = h1.slice(2).trim();
  if (!title.toLowerCase().endsWith(" skill")) {
    throw new SkillPackageError("SKILL_TITLE_INVALID", `SKILL.md 一级标题应以 Skill 结尾：${name}`);
  }
  let cursor = -1;
  for (const section of REQUIRED_SECTIONS) {
    const index = lines.findIndex((line, lineIndex) => lineIndex > cursor && line.trim() === `## ${section}`);
    if (index < 0) {
      throw new SkillPackageError("SKILL_SECTION_MISSING", `SKILL.md 缺少固定章节：## ${section}`);
    }
    cursor = index;
  }
}

function parseYamlSubset(text: string): Record<string, unknown> {
  const tokens = text.split("\n")
    .map((line) => ({ raw: line.replace(/\t/g, "  "), indent: line.match(/^ */)?.[0].length ?? 0 }))
    .filter((line) => line.raw.trim() && !line.raw.trim().startsWith("#"))
    .map((line) => ({ indent: line.indent, content: line.raw.trim() }));
  const [value] = parseYamlBlock(tokens, 0, 0);
  if (!isRecord(value)) throw new SkillPackageError("SKILL_FRONTMATTER_INVALID", "技能 frontmatter 必须是对象");
  return value;
}

function parseYamlBlock(
  tokens: Array<{ indent: number; content: string }>,
  start: number,
  indent: number
): [unknown, number] {
  if (tokens[start]?.content.startsWith("- ")) {
    const values: unknown[] = [];
    let cursor = start;
    while (cursor < tokens.length && tokens[cursor]!.indent === indent && tokens[cursor]!.content.startsWith("- ")) {
      values.push(parseYamlScalar(tokens[cursor]!.content.slice(2).trim()));
      cursor += 1;
    }
    return [values, cursor];
  }
  const object: Record<string, unknown> = {};
  let cursor = start;
  while (cursor < tokens.length && tokens[cursor]!.indent === indent) {
    const token = tokens[cursor]!;
    const separator = token.content.indexOf(":");
    if (separator <= 0) throw new SkillPackageError("SKILL_FRONTMATTER_INVALID", "无法解析 frontmatter 行：" + token.content);
    const key = token.content.slice(0, separator).trim();
    const rest = token.content.slice(separator + 1).trim();
    cursor += 1;
    if (rest) {
      object[key] = parseYamlScalar(rest);
      continue;
    }
    if (cursor < tokens.length && tokens[cursor]!.indent > indent) {
      const [child, next] = parseYamlBlock(tokens, cursor, tokens[cursor]!.indent);
      object[key] = child;
      cursor = next;
    } else {
      object[key] = {};
    }
  }
  return [object, cursor];
}

function parseYamlScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return {};
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return splitInlineArray(inner).map(parseYamlScalar);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      throw new SkillPackageError("SKILL_FRONTMATTER_INVALID", "frontmatter 字符串格式无效：" + trimmed);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  return trimmed;
}

function splitInlineArray(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      current += character;
      if (character === "\\" && quote === '"') {
        current += value[index + 1] ?? "";
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ",") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function requiredString(value: unknown, code: string, message: string): string {
  const result = optionalString(value);
  if (!result) throw new SkillPackageError(code, message);
  return result;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => optionalString(item)).filter((item): item is string => Boolean(item));
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function yamlArray(values: string[]): string {
  return "[" + values.map((value) => JSON.stringify(value)).join(", ") + "]";
}

function sha256(text: string): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
