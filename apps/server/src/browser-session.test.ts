import { describe, expect, it, vi } from "vitest";
import { BrowserSessionManager, browserFinishIssue } from "./browser-session.ts";
import type { BrowserService } from "./browser-service.ts";

function fakeService() {
  let count = 0;
  const pages: Array<Record<string, unknown>> = [];
  const context = {
    pages: () => pages,
    newPage: vi.fn(async () => {
      count += 1;
      const page = {
        id: count,
        url: () => "about:blank",
        title: vi.fn(async () => `tab ${count}`),
        bringToFront: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined)
      };
      pages.push(page);
      return page;
    })
  };
  return {
    service: { context: async () => context } as unknown as BrowserService,
    context,
    pages
  };
}

describe("BrowserSessionManager", () => {
  it("reuses one page per task and caps concurrent sessions", async () => {
    const fake = fakeService();
    const manager = new BrowserSessionManager(fake.service);
    try {
      const first = await manager.session("task-a");
      const again = await manager.session("task-a");
      expect(first).toBe(again);
      expect(first.tabs).toHaveLength(1);
      await manager.session("task-b");
      await manager.session("task-c");
      await manager.session("task-d");
      await expect(manager.session("task-e")).rejects.toMatchObject({ code: "BROWSER_SESSION_LIMIT" });
      await manager.release("task-a");
      await expect(manager.session("task-e")).resolves.toBeTruthy();
    } finally {
      manager.stop();
      await manager.releaseAll();
    }
  });

  it("blocks tools while paused and resumes", async () => {
    const fake = fakeService();
    const manager = new BrowserSessionManager(fake.service);
    try {
      await manager.session("task-a");
      expect(manager.pause("task-a")).toBe(true);
      await expect(manager.activePage("task-a")).rejects.toMatchObject({ code: "BROWSER_TAKEOVER" });
      expect(manager.resume("task-a")).toBe(true);
      await expect(manager.activePage("task-a")).resolves.toMatchObject({ session: { paused: false } });
    } finally {
      manager.stop();
      await manager.releaseAll();
    }
  });

  it("reclaims idle sessions", async () => {
    const fake = fakeService();
    const manager = new BrowserSessionManager(fake.service, { idleMs: 40 });
    try {
      const session = await manager.session("task-a");
      const page = session.tabs[0]!.page as unknown as { close: ReturnType<typeof vi.fn> };
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(manager.has("task-a")).toBe(false);
      expect(page.close).toHaveBeenCalled();
    } finally {
      manager.stop();
      await manager.releaseAll();
    }
  });
});

describe("browserFinishIssue", () => {
  it("does not gate a task that never touched the browser", () => {
    expect(browserFinishIssue(undefined)).toBeNull();
    expect(browserFinishIssue({ assertions: [], steps: [] } as never)).toBeNull();
  });

  it("requires at least one assertion after browser work", () => {
    const state = {
      steps: [{ tool: "browser_open", url: "https://example.com" }],
      assertions: []
    };
    expect(browserFinishIssue(state as never)).toMatch(/browser_assert/);
  });

  it("blocks completion on a failing assertion and reports what was expected", () => {
    const issue = browserFinishIssue({
      steps: [{ tool: "browser_open", url: "https://example.com" }],
      assertions: [{ kind: "text", expected: "提交成功", passed: false, actual: "提交失败" }]
    } as never);
    expect(issue).toContain("提交成功");
    expect(issue).toContain("提交失败");
  });

  it("allows completion once the last assertion passes", () => {
    expect(browserFinishIssue({
      steps: [{ tool: "browser_open", url: "https://example.com" }],
      assertions: [
        { kind: "text", expected: "旧文案", passed: false },
        { kind: "text", expected: "提交成功", passed: true }
      ]
    } as never)).toBeNull();
  });
});
