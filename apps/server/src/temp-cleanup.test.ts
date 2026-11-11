import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirectory } from "./temp-cleanup.ts";

describe("temporary directory cleanup", () => {
  let child: ChildProcess | null = null;
  let root: string | null = null;

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child?.once("exit", resolve));
    }
    child = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it.skipIf(process.platform !== "win32")("never throws when a provider still locks the directory", async () => {
    root = mkdtempSync(join(tmpdir(), "hearth-cleanup-lock-"));
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: root,
      stdio: "ignore",
      windowsHide: true
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(() => removeTempDirectory(root!)).not.toThrow();
  });
});
