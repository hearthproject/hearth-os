import { createHash, randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import type { HearthStore } from "@hearth/eventlog";
import type { SecretBox } from "./secrets.ts";
import type { MailAccountView, MailMessage, MailSendResult } from "./email.ts";

const CONFIG = "gmail.oauth.config.v1";
const ACCOUNTS = "gmail.oauth.accounts.v1";
const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_CALLBACK = "/api/mail/gmail/callback";
interface Config { clientId: string; secret: string; redirectUri: string }
interface Account { id: string; email: string; name: string; refresh: string; access: string; expires: number; clientId: string; createdAt: string; updatedAt: string }
interface Pending { verifier: string; expires: number; returnOrigin: string; config: Config }

export class GmailService {
  private pending = new Map<string, Pending>();
  private refreshing = new Map<string, Promise<string>>();
  constructor(private store: HearthStore, private secrets: SecretBox, private fetcher: typeof fetch = fetch) {}

  private config(): Config {
    const raw = this.store.getAppSetting(CONFIG);
    if (!raw) throw new Error("请先配置 Google OAuth 客户端。");
    return JSON.parse(raw) as Config;
  }
  settings() {
    const raw = this.store.getAppSetting(CONFIG);
    const config = raw ? JSON.parse(raw) as Config : null;
    return { clientId: config?.clientId ?? "", hasClientSecret: Boolean(config?.secret), redirectUri: config?.redirectUri ?? `http://127.0.0.1:4317${GMAIL_CALLBACK}` };
  }
  configure(input: { clientId: string; clientSecret?: string | undefined; redirectUri: string }) {
    const redirect = loopbackUrl(input.redirectUri);
    if (redirect.pathname !== GMAIL_CALLBACK || redirect.search || redirect.hash) throw new Error(`回调地址路径必须为 ${GMAIL_CALLBACK}`);
    const clientId = input.clientId.trim();
    if (!clientId.endsWith(".apps.googleusercontent.com")) throw new Error("请填写 Google Web 应用的 Client ID。");
    const previous = this.store.getAppSetting(CONFIG) ? this.config() : null;
    const secret = input.clientSecret?.trim() ? this.secrets.encrypt(input.clientSecret.trim()) : previous?.clientId === clientId ? previous.secret : "";
    if (!secret) throw new Error("请填写 Client Secret。");
    this.store.setAppSetting(CONFIG, JSON.stringify({ clientId, secret, redirectUri: redirect.href }));
    this.pending.clear();
    return this.settings();
  }
  start(returnOrigin: string) {
    const origin = loopbackUrl(returnOrigin).origin;
    const config = this.config();
    if (new URL(origin).hostname !== new URL(config.redirectUri).hostname) throw new Error("Hearth 页面与回调地址必须使用相同主机名（localhost 或 127.0.0.1），请统一后重试。");
    for (const [key, value] of this.pending) if (value.expires < Date.now()) this.pending.delete(key);
    if (this.pending.size >= 20) throw new Error("授权请求过多，请稍后重试。");
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    this.pending.set(state, { verifier, expires: Date.now() + 10 * 60_000, returnOrigin: origin, config });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: `openid email ${SEND_SCOPE}`, access_type: "offline", prompt: "consent", state, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") }).toString();
    return { url: url.href, state };
  }
  async callback(state: string, cookieState: string, code: string, denied?: string) {
    if (!state || state !== cookieState) throw new Error("授权会话不匹配，请从 Hearth 重新连接 Google。");
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expires < Date.now()) throw new Error("授权已过期或已使用，请重新连接。");
    if (denied || !code) throw new Error("Google 授权未完成，请重新连接并允许发送邮件权限。");
    const token = await this.exchange(pending.config, { grant_type: "authorization_code", code, redirect_uri: pending.config.redirectUri, code_verifier: pending.verifier });
    if (!String(token.scope ?? "").split(" ").includes(SEND_SCOPE)) throw new Error("未授予 Gmail 发送权限，请重新连接并勾选发送邮件。");
    if (typeof token.refresh_token !== "string" || !token.refresh_token) throw new Error("Google 未返回离线授权，请重新连接。");
    const identity = await this.json("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${token.access_token}` } });
    if (typeof identity.sub !== "string" || typeof identity.email !== "string" || identity.email_verified !== true) throw new Error("无法验证 Google 账户邮箱。");
    const id = `gmail:${identity.sub}`;
    const old = this.records().find((account) => account.id === id);
    const now = new Date().toISOString();
    const account: Account = { id, email: identity.email, name: identity.email, refresh: this.secrets.encrypt(token.refresh_token), access: this.secrets.encrypt(String(token.access_token)), expires: expiry(token.expires_in), clientId: pending.config.clientId, createdAt: old?.createdAt ?? now, updatedAt: now };
    this.save(account);
    return `${pending.returnOrigin}/mail?gmail=connected`;
  }
  private records(): Account[] { return JSON.parse(this.store.getAppSetting(ACCOUNTS) ?? "[]") as Account[]; }
  private save(account: Account) { this.store.setAppSetting(ACCOUNTS, JSON.stringify([...this.records().filter((item) => item.id !== account.id), account])); }
  private require(id: string) { const account = this.records().find((item) => item.id === id); if (!account) throw new Error("Gmail 账户已断开，请重新连接。"); return account; }
  list(): MailAccountView[] {
    return this.records().map((account) => {
      const server = { host: "gmail.googleapis.com", port: 443, secure: true, user: account.email, hasPassword: false, passwordMasked: null };
      return { id: account.id, name: "Gmail", fromName: "", fromAddress: account.email, authType: "google-oauth", smtp: server, imap: server, syncEnabled: false, syncIntervalMinutes: 15, createdAt: account.createdAt, updatedAt: account.updatedAt };
    });
  }
  remove(id: string) {
    this.require(id);
    this.store.setAppSetting(ACCOUNTS, JSON.stringify(this.records().filter((item) => item.id !== id)));
  }
  async test(id: string) { await this.accessToken(id, true); }
  private async accessToken(id: string, force = false): Promise<string> {
    const account = this.require(id);
    const config = this.config();
    if (account.clientId !== config.clientId) throw new Error("OAuth 客户端已更换，请重新连接此 Gmail 账户。");
    if (!force && account.expires > Date.now() + 60_000) return this.secrets.decrypt(account.access);
    const existing = this.refreshing.get(id);
    if (existing) return existing;
    const work = (async () => {
      const token = await this.exchange(config, { grant_type: "refresh_token", refresh_token: this.secrets.decrypt(account.refresh) });
      // Never resurrect an account removed while refreshing.
      const current = this.require(id);
      this.save({ ...current, access: this.secrets.encrypt(String(token.access_token)), ...(typeof token.refresh_token === "string" ? { refresh: this.secrets.encrypt(token.refresh_token) } : {}), expires: expiry(token.expires_in), updatedAt: new Date().toISOString() });
      return String(token.access_token);
    })();
    this.refreshing.set(id, work);
    try { return await work; } finally { this.refreshing.delete(id); }
  }
  async send(id: string, message: Omit<MailMessage, "from">): Promise<MailSendResult> {
    let token: string;
    try { token = await this.accessToken(id); }
    catch (error) { throw Object.assign(new Error(error instanceof Error ? error.message : "Google 授权不可用"), { code: "EAUTH" }); }
    const account = this.require(id);
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
    const options = { ...message, from: account.email, keepBcc: true };
    const mime = await transport.sendMail(options);
    if (!Buffer.isBuffer(mime.message)) throw new Error("无法生成 Gmail MIME 邮件。");
    const result = await this.json("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ raw: mime.message.toString("base64url") }) });
    if (typeof result.id !== "string") throw new Error("Gmail 未返回发送回执，请先在 Gmail 已发送中核对，勿重复发送。");
    return { messageId: result.id, accepted: [...message.to, ...message.cc, ...message.bcc], rejected: [], response: "Gmail API accepted" };
  }
  private async exchange(config: Config, values: Record<string, string>) {
    const token = await this.json("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...values, client_id: config.clientId, client_secret: this.secrets.decrypt(config.secret) }).toString() });
    if (typeof token.access_token !== "string" || !token.access_token) throw new Error("Google 未返回有效授权令牌，请重新连接。");
    return token;
  }
  private async json(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(30_000), redirect: "error" });
    if (!response.ok) {
      // Never echo Google's response body: it may contain credentials or message content.
      throw new Error(`Google 请求失败（${response.status}）。请检查 OAuth 客户端、Gmail API 是否启用及账户授权；授权过期或撤销时请重新连接。发送失败时先核对 Gmail 已发送记录。`);
    }
    return await response.json() as Record<string, unknown>;
  }
}

function expiry(value: unknown) { return Date.now() + (typeof value === "number" && value > 0 ? value : 3600) * 1000; }
function loopbackUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("当前仅支持本机 http://localhost 或 http://127.0.0.1 地址。");
  return url;
}
