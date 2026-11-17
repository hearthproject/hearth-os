import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { GmailService, GMAIL_CALLBACK } from "./gmail.ts";
import { SecretBox } from "./secrets.ts";
import { simpleParser } from "mailparser";

const scope = "https://www.googleapis.com/auth/gmail.send";
const config = { clientId: "test.apps.googleusercontent.com", clientSecret: "client-secret", redirectUri: `http://127.0.0.1:4317${GMAIL_CALLBACK}` };
describe("Google OAuth and Gmail sending", () => {
  let store: HearthStore;
  let gmail: GmailService;
  let requests: Array<{ url: string; init: RequestInit }>;
  let deniedScope: boolean;
  let failSend: boolean;
  beforeEach(() => {
    store = new HearthStore(":memory:"); requests = []; deniedScope = false; failSend = false;
    const fetcher = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/token")) return Response.json({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600, scope: deniedScope ? "email" : scope });
      if (String(url).endsWith("/userinfo")) return Response.json({ sub: "123", email: "me@gmail.com", email_verified: true });
      if (failSend) throw new Error("connection lost");
      return Response.json({ id: "gmail-message-id" });
    }) as typeof fetch;
    gmail = new GmailService(store, new SecretBox(Buffer.alloc(32, 8)), fetcher);
    gmail.configure(config);
  });
  afterEach(() => { vi.useRealTimers(); store.close(); });
  async function connect() { const { state } = gmail.start("http://127.0.0.1:5173"); return gmail.callback(state, state, "code"); }

  it("uses PKCE, send-only scope and a browser-bound one-time state", async () => {
    const { url, state } = gmail.start("http://127.0.0.1:5173");
    const params = new URL(url).searchParams;
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("scope")).toBe(`openid email ${scope}`);
    expect(params.get("scope")).not.toContain("gmail.readonly");
    await expect(gmail.callback(state, "wrong-browser", "code")).rejects.toThrow("不匹配");
    expect(requests).toHaveLength(0);
    expect(await gmail.callback(state, state, "code")).toBe("http://127.0.0.1:5173/mail?gmail=connected");
    await expect(gmail.callback(state, state, "code")).rejects.toThrow("已使用");
    expect(new URLSearchParams(String(requests[0]!.init.body)).get("code_verifier")).toBeTruthy();
  });
  it("rejects expired, cancelled and insufficient-scope authorization", async () => {
    vi.useFakeTimers();
    const { state } = gmail.start("http://127.0.0.1:5173");
    vi.advanceTimersByTime(601000);
    await expect(gmail.callback(state, state, "code")).rejects.toThrow("过期");
    vi.useRealTimers();
    const denied = gmail.start("http://127.0.0.1:5173");
    await expect(gmail.callback(denied.state, denied.state, "", "access_denied")).rejects.toThrow("未完成");
    deniedScope = true;
    await expect(connect()).rejects.toThrow("发送权限");
    expect(gmail.list()).toHaveLength(0);
  });
  it("encrypts secrets, refreshes authorization and removes accounts", async () => {
    await connect();
    expect(store.getAppSetting("gmail.oauth.config.v1")).not.toContain("client-secret");
    expect(store.getAppSetting("gmail.oauth.accounts.v1")).not.toContain("access-secret");
    expect(store.getAppSetting("gmail.oauth.accounts.v1")).not.toContain("refresh-secret");
    expect(JSON.stringify(gmail.list())).not.toContain("secret");
    await gmail.test("gmail:123");
    expect(new URLSearchParams(String(requests.at(-1)!.init.body)).get("grant_type")).toBe("refresh_token");
    gmail.remove("gmail:123");
    await expect(gmail.test("gmail:123")).rejects.toThrow("断开");
  });
  it("sends MIME including edited text, unicode and Bcc, without retrying an uncertain send", async () => {
    await connect();
    const message = { to: ["teacher@example.com"], cc: [], bcc: ["copy@example.com"], subject: "小兰请假", text: "明天来上课", attachments: [] };
    const result = await gmail.send("gmail:123", message);
    expect(result.messageId).toBe("gmail-message-id");
    const request = requests.at(-1)!;
    expect(request.url).toContain("/messages/send");
    const parsed = await simpleParser(Buffer.from(JSON.parse(String(request.init.body)).raw, "base64url"));
    expect(parsed.subject).toBe(message.subject);
    expect(parsed.text).toContain(message.text);
    expect(parsed.bcc).toMatchObject({ value: [{ address: "copy@example.com" }] });
    failSend = true;
    const count = requests.length;
    await expect(gmail.send("gmail:123", message)).rejects.toThrow("connection lost");
    expect(requests.length).toBe(count + 1);
  });
  it("rejects remote callbacks and mismatched local hostnames", () => {
    expect(() => gmail.configure({ ...config, redirectUri: `https://example.com${GMAIL_CALLBACK}` })).toThrow("本机");
    expect(() => gmail.start("http://localhost:5173")).toThrow("相同主机名");
  });
});
