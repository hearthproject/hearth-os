import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";
import { HearthService } from "./service.ts";
import { SourceRegistry, SourceRegistryError } from "./sources.ts";
import { WebInputError } from "./web-fetch.ts";

describe("source registry", () => {
  let root: string;
  let sourceRoot: string;
  let store: HearthStore;
  let service: HearthService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hearth-source-"));
    sourceRoot = join(root, "knowledge");
    mkdirSync(join(sourceRoot, "nested"), { recursive: true });
    writeFileSync(join(sourceRoot, "alpha.md"), "# Alpha\n\nFirst paragraph.\n", "utf8");
    writeFileSync(join(sourceRoot, "nested", "beta.txt"), "Beta content\n", "utf8");
    writeFileSync(join(sourceRoot, "ignored.bin"), "not text", "utf8");
    store = new HearthStore(":memory:");
    service = new HearthService(store);
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function registry(webFetch?: ConstructorParameters<typeof SourceRegistry>[1]["webFetch"]): SourceRegistry {
    return new SourceRegistry(service, {
      contentRoot: join(root, "source-content"),
      ...(webFetch ? { webFetch } : {})
    });
  }

  it("reads local files and skips unchanged content on the next pass", async () => {
    const sources = registry();
    const source = sources.create({ kind: "knowledge", displayName: "团队知识库", rootPath: sourceRoot });
    const first = await sources.read(source.id);

    expect(first.source.status).toBe("connected");
    expect(first.source.itemCount).toBe(2);
    expect(first.changed).toBe(2);
    expect(first.items.map((item) => item.locator).sort()).toEqual(["alpha.md", "nested/beta.txt"]);
    expect(first.items.every((item) => item.status === "ready" && item.contentHash)).toBe(true);
    expect(sources.readItemContent(first.items[0]!.id)).toContain("Alpha");

    const second = await sources.read(source.id);
    expect(second.changed).toBe(0);
    expect(second.items).toHaveLength(2);

    writeFileSync(join(sourceRoot, "alpha.md"), "# Alpha\n\nChanged paragraph.\n", "utf8");
    const third = await sources.read(source.id);
    expect(third.changed).toBe(1);
    expect(third.items.find((item) => item.locator === "alpha.md")?.contentHash)
      .not.toBe(first.items.find((item) => item.locator === "alpha.md")?.contentHash);
  });

  it("records duplicate content instead of storing it twice", async () => {
    writeFileSync(join(sourceRoot, "copy.md"), "# Alpha\n\nFirst paragraph.\n", "utf8");
    const sources = registry();
    const source = sources.create({ kind: "file", rootPath: sourceRoot });
    const result = await sources.read(source.id);
    const alpha = result.items.find((item) => item.locator === "alpha.md")!;
    const copy = result.items.find((item) => item.locator === "copy.md")!;

    expect(copy.duplicateOf).toBe(alpha.id);
    expect(copy.contentPath).toBe(alpha.contentPath);
  });

  it("rejects symlinks without following them", async () => {
    try {
      symlinkSync(join(root, "outside.md"), join(sourceRoot, "outside-link.md"), "file");
      writeFileSync(join(root, "outside.md"), "outside", "utf8");
    } catch {
      return;
    }
    const sources = registry();
    const source = sources.create({ kind: "knowledge", rootPath: sourceRoot });
    const result = await sources.read(source.id);
    const linked = result.items.find((item) => item.locator === "outside-link.md");
    expect(linked).toMatchObject({ status: "failed", error: { code: "symlink_rejected" } });
  });

  it("fetches public web pages through an injected safe fetcher", async () => {
    const sources = registry(async () => ({
      requestedUrl: "https://example.com/guide",
      finalUrl: "https://example.com/guide",
      fetchedAt: "2026-11-06T00:00:00.000Z",
      status: 200,
      contentType: "text/html",
      title: "Example Guide",
      markdown: "# Guide\n\nUseful content.",
      bytes: 120,
      sha256: "c".repeat(64)
    }));
    const source = sources.create({ kind: "web", allowedHosts: ["example.com"] });
    const first = await sources.read(source.id, { url: "https://example.com/guide" });
    expect(first.items[0]).toMatchObject({
      locator: "https://example.com/guide",
      title: "Example Guide",
      status: "ready",
      contentHash: "c".repeat(64)
    });
    expect(sources.readItemContent(first.items[0]!.id)).toContain("Guide");

    const second = await sources.read(source.id, { url: "https://example.com/guide" });
    expect(second.changed).toBe(0);
  });

  it("keeps a login or challenge page as needs_user instead of silently failing", async () => {
    const sources = registry(async () => {
      throw new WebInputError("access_challenge", "网页要求登录、验证码或浏览器验证");
    });
    const source = sources.create({ kind: "web", allowedHosts: ["example.com"] });
    await expect(sources.read(source.id, { url: "https://example.com/private" })).rejects.toBeInstanceOf(SourceRegistryError);
    expect(sources.get(source.id)).toMatchObject({
      status: "needs_user",
      lastError: { code: "access_challenge" }
    });
  });

  it("blocks reads after disconnect and clears stored content separately", async () => {
    const sources = registry();
    const source = sources.create({ kind: "knowledge", rootPath: sourceRoot });
    await sources.read(source.id);
    const disconnected = sources.disconnect(source.id);
    expect(disconnected.status).toBe("disconnected");
    await expect(sources.read(source.id)).rejects.toThrow("来源已断开");

    sources.reconnect(source.id);
    const cleared = sources.clear(source.id);
    expect(cleared.itemCount).toBe(0);
    expect(sources.items(source.id)).toHaveLength(0);
    expect(existsSync(join(root, "source-content", source.id))).toBe(false);
  });

  it("does not pretend email or calendar credentials exist", async () => {
    const sources = registry();
    const source = sources.create({ kind: "email" });
    expect(source.status).toBe("needs_user");
    expect(source.lastError?.code).toBe("credentials_required");
    await expect(sources.read(source.id)).rejects.toThrow("尚未配置");
  });

  it("exposes the source lifecycle over the local API", async () => {
    const app = await buildServer({ store, serveWeb: false, sourceContentRoot: join(root, "api-content") });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/sources",
        payload: { kind: "knowledge", displayName: "API 知识库", rootPath: sourceRoot }
      });
      expect(created.statusCode).toBe(201);
      const sourceId = created.json().id as string;

      const read = await app.inject({ method: "POST", url: `/api/sources/${sourceId}/read` });
      expect(read.statusCode).toBe(200);
      expect(read.json().items).toHaveLength(2);

      const items = await app.inject({ method: "GET", url: `/api/sources/${sourceId}/items` });
      expect(items.json().items).toHaveLength(2);

      const disconnected = await app.inject({ method: "POST", url: `/api/sources/${sourceId}/disconnect` });
      expect(disconnected.json().status).toBe("disconnected");
      const blocked = await app.inject({ method: "POST", url: `/api/sources/${sourceId}/read` });
      expect(blocked.statusCode).toBe(409);

      const cleared = await app.inject({ method: "POST", url: `/api/sources/${sourceId}/clear` });
      expect(cleared.json().itemCount).toBe(0);
    } finally {
      await app.close();
    }
  });
});
