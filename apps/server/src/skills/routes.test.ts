import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "../app.ts";

describe("skill routes", () => {
  let temp: string;
  let store: HearthStore;

  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), "hearth-skill-routes-"));
    mkdirSync(join(temp, "source"));
    writeFileSync(join(temp, "source", "SKILL.md"), "---\nname: 资料整理\ndescription: 整理资料\n---\n先分类。", "utf8");
    store = new HearthStore(":memory:");
  });

  afterEach(() => {
    store.close();
    rmSync(temp, { recursive: true, force: true });
  });

  it("requires confirmation and then exposes install, use and delete", async () => {
    const app = await buildServer({
      store,
      serveWeb: false,
      libraryEmbeddingProvider: null,
      skillRoot: join(temp, "managed")
    });

    const refused = await app.inject({ method: "POST", url: "/api/skills/install", payload: { source: join(temp, "source") } });
    expect(refused.statusCode).toBe(400);

    const installed = await app.inject({
      method: "POST",
      url: "/api/skills/install",
      payload: { source: join(temp, "source"), confirmed: true }
    });
    expect(installed.statusCode).toBe(201);
    const id = installed.json().skill.id;

    const list = await app.inject({ method: "GET", url: "/api/skills" });
    expect(list.json().skills).toHaveLength(1);

    const used = await app.inject({ method: "POST", url: `/api/skills/${id}/use`, payload: {} });
    expect(used.statusCode).toBe(200);
    expect(used.json().prompt).toContain("先分类");

    const removed = await app.inject({ method: "DELETE", url: `/api/skills/${id}` });
    expect(removed.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/skills" })).json().skills).toHaveLength(0);
    await app.close();
  });
});
