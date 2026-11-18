import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateRootLayout } from "./config.ts";

const roots: string[] = [];

function makeRoot(prefix = "hearth-config-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  mkdirSync(join(root, ".hearth"), { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("root layout", () => {
  it("accepts a root with .hearth and does not require web by default", () => {
    const root = makeRoot();
    expect(() => validateRootLayout(root, join(root, ".hearth"), join(root, "apps", "web", "dist"))).not.toThrow();
  });

  it("rejects a data directory with another name", () => {
    const root = makeRoot();
    expect(() => validateRootLayout(root, join(root, "data"), join(root, "apps", "web", "dist")))
      .toThrow(/必须是/);
  });

  it("rejects a data directory outside the root", () => {
    const root = makeRoot();
    const outside = mkdtempSync(join(tmpdir(), "hearth-outside-"));
    roots.push(outside);
    expect(() => validateRootLayout(root, join(outside, ".hearth"), join(root, "apps", "web", "dist")))
      .toThrow(/必须位于/);
  });

  it("requires index.html only when the caller asks for it", () => {
    const root = makeRoot();
    expect(() => validateRootLayout(root, join(root, ".hearth"), join(root, "apps", "web", "dist"), { requireWeb: true }))
      .toThrow(/前端未构建/);

    mkdirSync(join(root, "apps", "web", "dist"), { recursive: true });
    writeFileSync(join(root, "apps", "web", "dist", "index.html"), "<html></html>");
    expect(() => validateRootLayout(root, join(root, ".hearth"), join(root, "apps", "web", "dist"), { requireWeb: true }))
      .not.toThrow();
  });

  it.skipIf(process.platform !== "win32")("accepts a case difference in .hearth on Windows", () => {
    const root = makeRoot();
    const upper = join(root, ".HEARTH");
    mkdirSync(upper, { recursive: true });
    expect(() => validateRootLayout(root, upper, join(root, "apps", "web", "dist"))).not.toThrow();
  });
});
