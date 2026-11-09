import type { ArtifactMap, CsvGraderConfig, GraderConfig, GraderSpec, JsonGraderConfig, StateGraderConfig, TextGraderConfig } from "./types.ts";

export interface GraderOutcome {
  passed: boolean;
  reason: string;
  evidence: string[];
}

export function runGrader(spec: GraderSpec, artifacts: ArtifactMap): GraderOutcome {
  try {
    return gradeConfig(spec.config, artifacts);
  } catch (error) {
    return {
      passed: false,
      reason: error instanceof Error ? error.message : String(error),
      evidence: []
    };
  }
}

function gradeConfig(config: GraderConfig, artifacts: ArtifactMap): GraderOutcome {
  if (config.kind === "file") {
    const artifact = findArtifact(artifacts, config.path);
    if (!artifact) return fail(`缺少产物 ${config.path}`);
    if (config.minBytes !== undefined && artifact.bytes < config.minBytes) {
      return fail(`产物 ${config.path} 仅 ${artifact.bytes} bytes，低于 ${config.minBytes}`);
    }
    return pass(`产物 ${config.path} 存在`, [`${config.path}: ${artifact.bytes} bytes`]);
  }
  if (config.kind === "text") return gradeText(config, artifacts);
  if (config.kind === "json") return gradeJson(config, artifacts);
  if (config.kind === "csv") return gradeCsv(config, artifacts);
  if (config.kind === "artifact_count") {
    const matches = Object.keys(artifacts).filter((path) =>
      (!config.prefix || path.startsWith(config.prefix)) && (!config.suffix || path.endsWith(config.suffix))
    );
    return matches.length >= config.min
      ? pass(`匹配产物 ${matches.length} 个`, matches.slice(0, 20))
      : fail(`匹配产物仅 ${matches.length} 个，低于 ${config.min}`);
  }
  return gradeState(config, artifacts);
}

function gradeText(config: TextGraderConfig, artifacts: ArtifactMap): GraderOutcome {
  const artifact = findArtifact(artifacts, config.path);
  if (!artifact) return fail(`缺少产物 ${config.path}`);
  const text = normalizeText(artifact.text);
  const evidence: string[] = [];
  for (const expected of config.includes ?? []) {
    if (!text.includes(normalizeText(expected))) return fail(`缺少必要内容：${expected}`);
    evidence.push(`包含：${expected}`);
  }
  for (const forbidden of config.excludes ?? []) {
    if (text.includes(normalizeText(forbidden))) return fail(`包含禁止内容：${forbidden}`);
    evidence.push(`未包含：${forbidden}`);
  }
  for (const pattern of config.regex ?? []) {
    if (!new RegExp(pattern, "u").test(artifact.text)) return fail(`不匹配正则：${pattern}`);
    evidence.push(`匹配：${pattern}`);
  }
  return pass(`文本检查通过：${config.path}`, evidence);
}

function gradeJson(config: JsonGraderConfig, artifacts: ArtifactMap): GraderOutcome {
  const artifact = requireArtifact(artifacts, config.path);
  const parsed = JSON.parse(artifact.text) as unknown;
  const evidence: string[] = [];
  for (const path of config.requiredPaths ?? []) {
    if (readPath(parsed, path) === undefined) return fail(`JSON 缺少路径 ${path}`);
    evidence.push(`存在：${path}`);
  }
  for (const [path, expected] of Object.entries(config.equals ?? {})) {
    const actual = readPath(parsed, path);
    if (!deepEqual(actual, expected)) return fail(`JSON ${path} 不等于期望值`);
    evidence.push(`${path} = ${JSON.stringify(expected)}`);
  }
  for (const [path, minimum] of Object.entries(config.minArrayLength ?? {})) {
    const value = readPath(parsed, path);
    if (!Array.isArray(value) || value.length < minimum) return fail(`JSON ${path} 数组长度低于 ${minimum}`);
    evidence.push(`${path} 长度 ${value.length}`);
  }
  return pass(`JSON 检查通过：${config.path}`, evidence);
}

function gradeCsv(config: CsvGraderConfig, artifacts: ArtifactMap): GraderOutcome {
  const artifact = requireArtifact(artifacts, config.path);
  const rows = parseCsv(artifact.text);
  const header = rows[0] ?? [];
  const dataRows = rows.slice(1).filter((row) => row.some((cell) => cell.trim().length > 0));
  const evidence: string[] = [];
  for (const column of config.requiredColumns ?? []) {
    if (!header.includes(column)) return fail(`CSV 缺少列 ${column}`);
    evidence.push(`列：${column}`);
  }
  if (config.minRows !== undefined && dataRows.length < config.minRows) {
    return fail(`CSV 数据行 ${dataRows.length} 少于 ${config.minRows}`);
  }
  for (const required of config.requiredValues ?? []) {
    const index = header.indexOf(required.column);
    if (index < 0 || !dataRows.some((row) => row[index] === required.equals)) {
      return fail(`CSV 列 ${required.column} 缺少值 ${required.equals}`);
    }
    evidence.push(`${required.column} 包含 ${required.equals}`);
  }
  return pass(`CSV 检查通过：${config.path}`, evidence);
}

function gradeState(config: StateGraderConfig, artifacts: ArtifactMap): GraderOutcome {
  const artifact = requireArtifact(artifacts, config.path);
  const parsed = JSON.parse(artifact.text) as unknown;
  if (!containsSubset(parsed, config.expected)) return fail(`状态未达到期望：${config.path}`);
  return pass(`状态检查通过：${config.path}`, [JSON.stringify(config.expected)]);
}

function findArtifact(artifacts: ArtifactMap, path: string): ArtifactMap[string] | undefined {
  const normalized = normalizeArtifactPath(path);
  const exact = artifacts[normalized];
  if (exact) return exact;
  const suffix = `/${normalized}`;
  const key = Object.keys(artifacts).find((candidate) => normalizeArtifactPath(candidate).endsWith(suffix));
  return key ? artifacts[key] : undefined;
}

function requireArtifact(artifacts: ArtifactMap, path: string): ArtifactMap[string] {
  const artifact = findArtifact(artifacts, path);
  if (!artifact) throw new Error(`缺少产物 ${path}`);
  return artifact;
}

function pass(reason: string, evidence: string[]): GraderOutcome {
  return { passed: true, reason, evidence };
}

function fail(reason: string): GraderOutcome {
  return { passed: false, reason, evidence: [] };
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").toLocaleLowerCase();
}

function normalizeArtifactPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = "";
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

export function readPath(value: unknown, path: string): unknown {
  const segments = path.split(".").filter(Boolean);
  let current: unknown = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function containsSubset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every((item, index) => containsSubset(actual[index], item));
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    return Object.entries(expected).every(([key, value]) => containsSubset(actual[key], value));
  }
  return deepEqual(actual, expected);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
