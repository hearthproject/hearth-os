import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";
import { SecretBox } from "./secrets.ts";
import { WebSearchError, WebSearchService } from "./web-search.ts";

describe("web search settings", () => {
  let store: HearthStore;
  const secretBox = new SecretBox(Buffer.alloc(32, 7));

  beforeEach(() => {
    store = new HearthStore(":memory:");
  });

  afterEach(() => store.close());

  it("is disabled by default and never exposes a stored key", async () => {
    const service = new WebSearchService({ store, secretBox });
    expect(service.view()).toMatchObject({ enabled: false, provider: "tavily", hasApiKey: false, apiKeyMasked: null });

    const enabled = service.update({ enabled: true, provider: "tavily", apiKey: "tvly-secret-key" });
    expect(enabled).toMatchObject({ enabled: true, hasApiKey: true });
    expect(enabled.apiKeyMasked).toBe("tv••••-key");
    expect(JSON.stringify(enabled)).not.toContain("tvly-secret-key");
  });

  it("rejects enabling Tavily without a key", () => {
    const service = new WebSearchService({ store, secretBox });
    expect(() => service.update({ enabled: true, provider: "tavily" })).toThrow(WebSearchError);
  });

  it("serves masked settings through the local API", async () => {
    const app = await buildServer({ store, serveWeb: false, syncSecretBox: secretBox });
    const initial = await app.inject({ method: "GET", url: "/api/web-search/settings" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().enabled).toBe(false);

    const saved = await app.inject({
      method: "PATCH",
      url: "/api/web-search/settings",
      payload: { enabled: true, provider: "searxng", searxngUrl: "http://127.0.0.1:8888" }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ enabled: true, provider: "searxng", searxngUrl: "http://127.0.0.1:8888" });
    await app.close();
  });
});

describe("web search adapters", () => {
  let store: HearthStore;
  const secretBox = new SecretBox(Buffer.alloc(32, 8));

  beforeEach(() => {
    store = new HearthStore(":memory:");
  });

  afterEach(() => store.close());

  it("maps Tavily results and requires research permission in the tool", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const service = new WebSearchService({
      store,
      secretBox,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return Response.json({ results: [{ title: "Hearth", url: "https://example.com/hearth", content: "local agent" }] });
      }
    });
    service.update({ enabled: true, provider: "tavily", apiKey: "tvly-test" });
    const response = await service.search("hearth agent");
    expect(response.results).toEqual([{ title: "Hearth", url: "https://example.com/hearth", snippet: "local agent" }]);
    expect(requests[0]?.url).toBe("https://api.tavily.com/search");

    const tool = service.tool();
    const context = {
      workspaceRoot: process.cwd(),
      outDir: process.cwd(),
      permissions: { readRoots: [process.cwd()], writeRoots: [], networkHosts: ["example.com"], tools: ["web_search"] },
      signal: new AbortController().signal
    };
    await expect(tool.execute({ query: "hearth" }, context)).rejects.toThrow("公共网络搜索权限");
  });

  it("maps SearXNG results and rejects unsafe result URLs", async () => {
    const service = new WebSearchService({
      store,
      secretBox,
      fetchImpl: async () => Response.json({ results: [
        { title: "Public", url: "https://example.com/public", content: "<b>ok</b>" },
        { title: "Credential", url: "https://user:pass@example.com/private", content: "drop" }
      ] })
    });
    service.update({ enabled: true, provider: "searxng", searxngUrl: "http://127.0.0.1:8888/" });
    const response = await service.search("local first", { maxResults: 5 });
    expect(response.provider).toBe("searxng");
    expect(response.results).toEqual([{ title: "Public", url: "https://example.com/public", snippet: "ok" }]);
  });
});
