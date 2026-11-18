import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  candidateFor,
  configCandidate,
  existingCandidate,
  freshCandidate,
  readDesktopConfig,
  resolveDesktopConfigPath,
  writeDesktopConfig
} from "./data-root";

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-root-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("desktop data root", () => {
  it("describes a candidate and detects an existing database", () => {
    const root = makeDir();
    const candidate = candidateFor(root);
    expect(candidate.root).toBe(root);
    expect(candidate.dataDir).toBe(join(root, ".hearth"));
    expect(candidate.hasDatabase).toBe(false);

    mkdirSync(candidate.dataDir, { recursive: true });
    writeFileSync(candidate.databasePath, "");
    expect(candidateFor(root).hasDatabase).toBe(true);
  });

  it("creates a fresh root under the supplied LOCALAPPDATA", () => {
    const localAppData = makeDir();
    const fresh = freshCandidate(localAppData);
    expect(fresh.root).toBe(join(localAppData, "Hearth"));
    expect(fresh.dataDir).toBe(join(localAppData, "Hearth", ".hearth"));
    expect(fresh.hasDatabase).toBe(false);
  });

  it("writes and reads a desktop config", () => {
    const localAppData = makeDir();
    const configPath = resolveDesktopConfigPath(localAppData);
    const root = makeDir();
    mkdirSync(join(root, ".hearth"), { recursive: true });

    const written = writeDesktopConfig(configPath, root);
    expect(written.root).toBe(root);
    expect(written.dataDir).toBe(join(root, ".hearth"));
    expect(written.lastLaunchAt).not.toBe("");

    const read = readDesktopConfig(configPath);
    expect(read?.root).toBe(root);
    expect(configCandidate(configPath)?.root).toBe(root);
  });

  it("rejects a config whose dataDir is not .hearth", () => {
    const localAppData = makeDir();
    const configPath = resolveDesktopConfigPath(localAppData);
    mkdirSync(join(localAppData, "Hearth"), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      root: "D:\\App\\hearth-os",
      dataDir: "D:\\App\\hearth-os\\data",
      lastLaunchAt: ""
    }));

    expect(readDesktopConfig(configPath)).toBeNull();
  });

  it("uses the existing candidate for the repository root", () => {
    const existing = existingCandidate("D:\\App\\hearth-os");
    expect(existing.root).toBe("D:\\App\\hearth-os");
    expect(existing.dataDir).toBe("D:\\App\\hearth-os\\.hearth");
  });
});
