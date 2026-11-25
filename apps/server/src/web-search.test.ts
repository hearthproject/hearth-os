import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("is available without credentials and never exposes a stored legacy key", async () => {
    const service = new WebSearchService({ store, secretBox });
    expect(service.view()).toMatchObject({
      enabled: true,
      provider: "auto",
      hasApiKey: false,
      apiKeyMasked: null
    });

    const enabled = service.update({ enabled: true, provider: "tavily", apiKey: "tvly-secret-key" });
    expect(enabled).toMatchObject({ enabled: true, provider: "tavily", hasApiKey: true });
    expect(enabled.apiKeyMasked).toBe("tv••••-key");
    expect(JSON.stringify(enabled)).not.toContain("tvly-secret-key");
  });

  it("keeps legacy installations usable after upgrading from the disabled default", () => {
    store.setAppSetting("extensions.web-search.v1", JSON.stringify({ enabled: false, provider: "tavily" }));
    const service = new WebSearchService({ store, secretBox });
    expect(service.view()).toMatchObject({ enabled: true, provider: "tavily" });
  });

  it("rejects explicitly selecting Tavily without a key", () => {
    const service = new WebSearchService({ store, secretBox });
    expect(() => service.update({ enabled: true, provider: "tavily" })).toThrow(WebSearchError);
  });

  it("serves zero-config settings through the local API", async () => {
    const app = await buildServer({ store, serveWeb: false, secretBox });
    try {
      const initial = await app.inject({ method: "GET", url: "/api/web-search/settings" });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toMatchObject({ enabled: true, provider: "auto" });

      const restored = await app.inject({
        method: "PATCH",
        url: "/api/web-search/settings",
        payload: { provider: "auto" }
      });
      expect(restored.statusCode).toBe(200);
      expect(restored.json()).toMatchObject({ enabled: true, provider: "auto" });
    } finally {
      await app.close();
    }
  });
});

describe("web search adapters", () => {
  let store: HearthStore;
  const secretBox = new SecretBox(Buffer.alloc(32, 8));

  beforeEach(() => {
    store = new HearthStore(":memory:");
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    store.close();
  });

  it("maps Tavily results, ranks them and requires research permission in the tool", async () => {
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
    expect(response.provider).toBe("tavily");
    expect(response.results).toEqual([{
      rank: 1,
      title: "Hearth",
      url: "https://example.com/hearth",
      snippet: "local agent"
    }]);
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
    expect(response.results).toEqual([{ rank: 1, title: "Public", url: "https://example.com/public", snippet: "ok" }]);
  });

  it("uses the built-in Bing RSS feed without any settings", async () => {
    const requests: string[] = [];
    const service = new WebSearchService({
      store,
      secretBox,
      fetchImpl: async (url) => {
        requests.push(String(url));
        return new Response(`<?xml version="1.0"?><rss><channel><item><title><![CDATA[Hearth &amp; local AI]]></title><link>https://example.com/hearth?a=1&amp;b=2</link><description><![CDATA[<b>Local</b> agent OS]]></description><pubDate>Mon, 24 Nov 2026 10:00:00 GMT</pubDate></item><item><title>Duplicate</title><link>https://example.com/hearth?a=1&amp;b=2#fragment</link><description>duplicate</description></item></channel></rss>`, {
          headers: { "content-type": "text/xml" }
        });
      }
    });
    const response = await service.search("hearth");
    expect(response).toMatchObject({ provider: "bing-rss", attemptedProviders: ["bing-rss"] });
    expect(response.results).toEqual([{
      rank: 1,
      title: "Hearth & local AI",
      url: "https://example.com/hearth?a=1&b=2",
      snippet: "Local agent OS",
      publishedAt: "Mon, 24 Nov 2026 10:00:00 GMT"
    }]);
    expect(requests[0]).toContain("format=rss");
    expect(requests[0]).toContain("q=hearth");
  });

  it("prefers a configured relay and falls back to the public feed when it fails", async () => {
    vi.stubEnv("HEARTH_SEARCH_RELAY_URL", "https://relay.example/search");
    let calls = 0;
    const service = new WebSearchService({
      store,
      secretBox,
      fetchImpl: async (url) => {
        calls += 1;
        if (String(url).startsWith("https://relay.example/")) return new Response("down", { status: 503 });
        return new Response(`<rss><channel><item><title>Fallback</title><link>https://example.com/fallback</link><description>feed</description></item></channel></rss>`, {
          headers: { "content-type": "text/xml" }
        });
      }
    });
    const response = await service.search("fallback");
    expect(calls).toBe(2);
    expect(response.provider).toBe("bing-rss");
    expect(response.attemptedProviders).toEqual(["relay", "bing-rss"]);
  });

  it("uses DuckDuckGo before the optional browser fallback and unwraps redirect links", async () => {
    let browserCalls = 0;
    const service = new WebSearchService({
      store,
      secretBox,
      fetchImpl: async () => new Response(`<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://example.com/result")}">Result</a><div class="result__snippet">Snippet</div></div>`, {
        headers: { "content-type": "text/html" }
      })
    });
    service.setBrowserFallback({
      search: async () => {
        browserCalls += 1;
        return [{ title: "Browser", url: "https://example.com/browser", snippet: "" }];
      }
    });
    const response = await service.search("result");
    expect(response.provider).toBe("duckduckgo");
    expect(response.results[0]).toMatchObject({ rank: 1, title: "Result", url: "https://example.com/result" });
    expect(browserCalls).toBe(0);
  });

  it("reads top results through the same public-network guard when requested", async () => {
    const service = new WebSearchService({
      store,
      secretBox,
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers);
        if (headers.get("accept")?.includes("xhtml")) {
          return new Response("<html><head><title>Article</title></head><body><article><p>Full article text.</p></article></body></html>", {
            headers: { "content-type": "text/html" }
          });
        }
        return new Response(`<rss><channel><item><title>Article</title><link>https://example.com/article</link><description>Summary</description></item></channel></rss>`, {
          headers: { "content-type": "text/xml" }
        });
      }
    });
    const tool = service.tool();
    const result = await tool.execute({ query: "article", readTop: 1 }, {
      workspaceRoot: process.cwd(),
      outDir: process.cwd(),
      permissions: { readRoots: [process.cwd()], writeRoots: [], networkHosts: ["*"], tools: ["web_search"] },
      signal: new AbortController().signal
    });
    expect(result.content).toContain("Full article text");
  });
});
