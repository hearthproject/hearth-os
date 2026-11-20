import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSettingsStore, domainMatches } from "./browser-settings.ts";

describe("browser settings", () => {
  it("matches exact domains, subdomains and wildcards", () => {
    expect(domainMatches("example.com", "example.com")).toBe(true);
    expect(domainMatches("app.example.com", "example.com")).toBe(true);
    expect(domainMatches("app.example.com", "*.example.com")).toBe(true);
    expect(domainMatches("evil-example.com", "example.com")).toBe(false);
    expect(domainMatches("anything.test", "*")).toBe(true);
  });

  it("persists lists, de-duplicates and clamps session count", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-browser-settings-"));
    try {
      const store = new BrowserSettingsStore(join(dir, "settings.json"));
      const next = store.update({
        allowedDomains: ["Example.com", "example.com"],
        readOnlyDomains: ["docs.example.com"],
        maxSessions: 99
      });
      expect(next.allowedDomains).toEqual(["example.com"]);
      expect(next.readOnlyDomains).toEqual(["docs.example.com"]);
      expect(next.maxSessions).toBe(8);
      expect(store.get().allowedDomains).toEqual(["example.com"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
