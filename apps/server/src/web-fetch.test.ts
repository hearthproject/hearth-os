import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { fetchWebSnapshot, isPrivateAddress, WebInputError } from "./web-fetch.ts";

describe("safe web input", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = null;
  });

  it("recognizes private IPv4 and IPv6 ranges", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.2.3.4")).toBe(true);
    expect(isPrivateAddress("172.20.10.2")).toBe(true);
    expect(isPrivateAddress("192.168.1.2")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });

  it("rejects hosts outside the task allowlist before making a request", async () => {
    await expect(fetchWebSnapshot("https://example.com/", {
      allowedHosts: ["docs.example.org"]
    })).rejects.toMatchObject({ code: "host_not_allowed" });
  });

  it("fetches, follows allowed redirects, and converts tables, links, and code to Markdown", async () => {
    const { origin } = await startServer();
    const snapshot = await fetchWebSnapshot(`${origin}/redirect`, {
      allowedHosts: ["127.0.0.1"],
      allowPrivate: true
    });

    expect(snapshot.status).toBe(200);
    expect(snapshot.finalUrl).toBe(`${origin}/page`);
    expect(snapshot.title).toBe("Hearth Test Guide");
    expect(snapshot.markdown).toContain("# Guide");
    expect(snapshot.markdown).toContain("[Next](" + origin + "/next)");
    expect(snapshot.markdown).toContain("```");
    expect(snapshot.markdown).toContain("| Name | Value |");
    expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fetches JSON APIs and returns a readable fenced block", async () => {
    const { origin } = await startServer();
    const snapshot = await fetchWebSnapshot(`${origin}/data.json`, {
      allowedHosts: ["127.0.0.1"],
      allowPrivate: true
    });

    expect(snapshot.contentType).toContain("application/json");
    expect(snapshot.markdown).toContain("```json");
    expect(snapshot.markdown).toContain('"name": "Hearth"');
    expect(snapshot.markdown).toContain('"stars": 42');
  });

  it("returns plain Markdown files without running them through the HTML converter", async () => {
    const { origin } = await startServer();
    const snapshot = await fetchWebSnapshot(`${origin}/SKILL.md`, {
      allowedHosts: ["127.0.0.1"],
      allowPrivate: true
    });

    expect(snapshot.title).toBe("# Grill Me");
    expect(snapshot.markdown).toBe("# Grill Me\n\nAsk one question at a time.");
  });

  it("blocks a redirect that leaves the allowlist", async () => {
    const { origin } = await startServer();
    await expect(fetchWebSnapshot(`${origin}/escape`, {
      allowedHosts: ["127.0.0.1"],
      allowPrivate: true
    })).rejects.toBeInstanceOf(WebInputError);
  });

  async function startServer(): Promise<{ origin: string }> {
    server = createServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/page" });
        response.end();
        return;
      }
      if (request.url === "/escape") {
        response.writeHead(302, { location: "http://localhost/private" });
        response.end();
        return;
      }
      if (request.url === "/data.json") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ name: "Hearth", stars: 42, topics: ["agent", "runtime"] }));
        return;
      }
      if (request.url === "/SKILL.md") {
        response.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
        response.end("# Grill Me\n\nAsk one question at a time.");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Hearth Test Guide</title></head><body>
        <nav>Navigation</nav>
        <main>
          <h1>Guide</h1>
          <p>Read the <a href="/next">Next</a> page.</p>
          <table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr></tbody></table>
          <pre><code>const value = 1;</code></pre>
        </main>
        <footer>Footer</footer>
      </body></html>`);
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    return { origin: `http://127.0.0.1:${address.port}` };
  }
});
