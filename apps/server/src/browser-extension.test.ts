import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExtensionBrowserConnection,
  parseJsonResult,
  parseTabsMarkdown
} from "./browser-extension.ts";
import { extensionLocateCode } from "./browser-page.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Playwright Extension bridge", () => {
  it("saves a pairing token and reports only its presence", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-extension-"));
    tempDirs.push(dir);
    const tokenPath = join(dir, "extension-token");

    ExtensionBrowserConnection.saveToken(tokenPath, "1234567890abcdef");

    expect(readFileSync(tokenPath, "utf8")).toBe("1234567890abcdef");
    const status = ExtensionBrowserConnection.status(tokenPath);
    expect(status).toMatchObject({
      paired: true,
      extensionId: "mmlmfjhmonkocbjadbfplnigmagldckm"
    });
    expect(JSON.stringify(status)).not.toContain("1234567890abcdef");
  });

  it("parses the tab list and identifies the current tab", () => {
    const tabs = parseTabsMarkdown(`### Open tabs
- 0: [Home](https://example.com/home)
- 1: (current) [Account settings](https://example.com/account)
- 2: [Crashed](about:blank) [crashed]`);

    expect(tabs).toEqual([
      { index: 0, current: false, title: "Home", url: "https://example.com/home" },
      { index: 1, current: true, title: "Account settings", url: "https://example.com/account" },
      { index: 2, current: false, title: "Crashed", url: "about:blank" }
    ]);
  });

  it("extracts the result section instead of the generated code section", () => {
    const parsed = parseJsonResult<{ ok: boolean; title: string }>({
      content: [{
        type: "text",
        text: `### Result
{"ok":true,"title":"Account {settings}"}

### Ran Playwright code
\`\`\`js
await (async (page) => { return { ignored: true }; })(page);
\`\`\``
      }]
    });

    expect(parsed).toEqual({ ok: true, title: "Account {settings}" });
  });

  it("prefers structured content when MCP provides it", () => {
    expect(parseJsonResult<{ value: number }>({ structuredContent: { result: { value: 7 } } })).toEqual({ value: 7 });
  });

  it("redacts typed text from extension parse errors", () => {
    expect(() => parseJsonResult({
      content: [{
        type: "text",
        text: `### Ran Playwright code
await item.fill("private-password")
### Error
locator.fill failed for private-password`
      }]
    }, ["private-password"])).toThrow(/\[REDACTED\]/);

    try {
      parseJsonResult({
        content: [{ type: "text", text: "locator.fill failed for private-password" }]
      }, ["private-password"]);
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain("private-password");
    }
  });

  it("locates epoch-scoped refs across frames before invoking Playwright", () => {
    const code = extensionLocateCode("4:e9", "await item.click();");
    expect(code).toContain("page.frames()");
    expect(code).toContain('[data-hearth-ref="4:e9"]');
    expect(code).toContain("await item.click();");
  });
});
