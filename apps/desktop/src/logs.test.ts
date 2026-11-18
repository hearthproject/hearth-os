import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RotatingLog } from "./logs";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("rotating desktop logs", () => {
  it("rotates before exceeding the size limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-logs-"));
    dirs.push(dir);
    const log = new RotatingLog(join(dir, "main.log"), 100, 2);

    log.write("a".repeat(60));
    log.write("b".repeat(60));

    expect(existsSync(join(dir, "main.log.1"))).toBe(true);
    expect(readFileSync(join(dir, "main.log.1"), "utf8")).toBe(`${"a".repeat(60)}\n`);
    expect(readFileSync(join(dir, "main.log"), "utf8")).toBe(`${"b".repeat(60)}\n`);
  });

  it("keeps only the configured number of rotated files", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-logs-"));
    dirs.push(dir);
    const log = new RotatingLog(join(dir, "main.log"), 20, 2);

    log.write("1".repeat(20));
    log.write("2".repeat(20));
    log.write("3".repeat(20));
    log.write("4".repeat(20));

    expect(existsSync(join(dir, "main.log.1"))).toBe(true);
    expect(existsSync(join(dir, "main.log.2"))).toBe(true);
    expect(existsSync(join(dir, "main.log.3"))).toBe(false);
  });
});
