import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ProjectCommands {
  test?: string;
  lint?: string;
  typecheck?: string;
  format?: string;
  build?: string;
}

export interface ProjectProfile {
  language: string | null;
  packageManager: string | null;
  commands: ProjectCommands;
  markers: string[];
}

const CACHE = new Map<string, { stamp: string; profile: ProjectProfile }>();

export function detectProjectProfile(root: string): ProjectProfile {
  const stamp = projectStamp(root);
  const cached = CACHE.get(root);
  if (cached?.stamp === stamp) return cached.profile;
  const profile = detect(root);
  CACHE.set(root, { stamp, profile });
  return profile;
}

export function describeProjectProfile(profile: ProjectProfile): string {
  const commands = Object.entries(profile.commands)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
  if (!profile.language && !commands) return "unknown";
  return [
    profile.language ? `language=${profile.language}` : "",
    profile.packageManager ? `package_manager=${profile.packageManager}` : "",
    commands ? `commands=[${commands}]` : ""
  ].filter(Boolean).join(", ");
}

function detect(root: string): ProjectProfile {
  if (existsSync(join(root, "package.json"))) {
    const scripts = readJsonScripts(join(root, "package.json"));
    const packageManager = detectPackageManager(root);
    return {
      language: existsSync(join(root, "tsconfig.json")) ? "typescript" : "javascript",
      packageManager,
      commands: {
        ...(scripts.test ? { test: `${packageManager} test` } : {}),
        ...(scripts.lint ? { lint: `${packageManager} run lint` } : {}),
        ...(scripts.typecheck
          ? { typecheck: `${packageManager} run typecheck` }
          : existsSync(join(root, "tsconfig.json"))
            ? { typecheck: `${packageManager} exec tsc --noEmit` }
            : {}),
        ...(scripts.format ? { format: `${packageManager} run format` } : {}),
        ...(scripts.build ? { build: `${packageManager} run build` } : {})
      },
      markers: ["package.json"]
    };
  }
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "requirements.txt")) || existsSync(join(root, "setup.py"))) {
    return {
      language: "python",
      packageManager: "python",
      commands: {
        test: "python -m pytest",
        ...(hasPythonTool(root, "ruff") ? { lint: "python -m ruff check ." } : {}),
        ...(hasPythonTool(root, "mypy") ? { typecheck: "python -m mypy ." } : {}),
        ...(hasPythonTool(root, "ruff") ? { format: "python -m ruff format ." } : {})
      },
      markers: ["pyproject.toml", "requirements.txt", "setup.py"].filter((name) => existsSync(join(root, name)))
    };
  }
  if (existsSync(join(root, "Cargo.toml"))) {
    return {
      language: "rust",
      packageManager: "cargo",
      commands: { test: "cargo test", lint: "cargo clippy --all-targets", typecheck: "cargo check", format: "cargo fmt" },
      markers: ["Cargo.toml"]
    };
  }
  if (existsSync(join(root, "go.mod"))) {
    return { language: "go", packageManager: "go", commands: { test: "go test ./...", lint: "go vet ./...", format: "gofmt -w .", build: "go build ./..." }, markers: ["go.mod"] };
  }
  if (existsSync(join(root, "pom.xml"))) {
    return { language: "java", packageManager: "maven", commands: { test: "mvn test", lint: "mvn -q verify", build: "mvn -q package" }, markers: ["pom.xml"] };
  }
  if (existsSync(join(root, "build.gradle")) || existsSync(join(root, "build.gradle.kts"))) {
    const gradle = existsSync(join(root, "gradlew")) ? "./gradlew" : "gradle";
    return { language: "java", packageManager: "gradle", commands: { test: `${gradle} test`, build: `${gradle} build` }, markers: ["build.gradle"] };
  }
  if (existsSync(join(root, "Makefile"))) {
    return { language: null, packageManager: "make", commands: { test: "make test", build: "make" }, markers: ["Makefile"] };
  }
  return { language: null, packageManager: null, commands: {}, markers: [] };
}

function readJsonScripts(path: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, unknown> };
    const scripts: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed.scripts ?? {})) {
      if (typeof value === "string" && value.trim()) scripts[name] = value;
    }
    return scripts;
  } catch {
    return {};
  }
}

function detectPackageManager(root: string): string {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
  return "npm";
}

function hasPythonTool(root: string, tool: string): boolean {
  const pyproject = join(root, "pyproject.toml");
  if (existsSync(pyproject)) {
    try {
      return readFileSync(pyproject, "utf8").includes(tool);
    } catch {
      return false;
    }
  }
  return false;
}

function projectStamp(root: string): string {
  const files = ["package.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "Makefile"];
  return files.map((name) => {
    try {
      const stat = existsSync(join(root, name)) ? statMtime(join(root, name)) : 0;
      return `${name}:${stat}`;
    } catch {
      return `${name}:0`;
    }
  }).join("|");
}

function statMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
