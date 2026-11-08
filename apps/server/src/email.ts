import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import type { HearthStore } from "@hearth/eventlog";
import type { SecretBox } from "./secrets.ts";

const ACCOUNTS_KEY = "mail.accounts.v1";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface MailServerInput {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password?: string | undefined;
}

export interface MailAccountInput {
  name: string;
  fromName: string;
  fromAddress: string;
  smtp: MailServerInput;
  imap: MailServerInput;
  syncEnabled?: boolean | undefined;
  syncIntervalMinutes?: number | undefined;
}

export interface MailServerRecord {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  passwordCipher: string;
}

export interface MailAccountRecord {
  id: string;
  name: string;
  fromName: string;
  fromAddress: string;
  smtp: MailServerRecord;
  imap: MailServerRecord;
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export interface MailServerView {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  hasPassword: boolean;
  passwordMasked: string | null;
}

export interface MailAccountView {
  id: string;
  name: string;
  fromName: string;
  fromAddress: string;
  smtp: MailServerView;
  imap: MailServerView;
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export interface MailAccountRuntime extends Omit<MailAccountRecord, "smtp" | "imap"> {
  smtp: Omit<MailServerRecord, "passwordCipher"> & { password: string };
  imap: Omit<MailServerRecord, "passwordCipher"> & { password: string };
}

export interface MailMessage {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  messageId?: string;
  attachments: Array<{ filename: string; path: string; contentType: string }>;
}

export interface MailSendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response: string;
}

export interface MailSmtpTransport {
  verify(): Promise<unknown>;
  sendMail(message: MailMessage): Promise<MailSendResult>;
  close?(): void;
}

export interface MailImapTransport {
  connect(): Promise<void>;
  logout(): Promise<void>;
}

export type MailSmtpFactory = (account: MailAccountRuntime) => MailSmtpTransport;
export type MailImapFactory = (account: MailAccountRuntime) => MailImapTransport;

export interface MailTestResult {
  ok: boolean;
  smtp: { ok: boolean; error: string | null; elapsedMs: number };
  imap: { ok: boolean; error: string | null; elapsedMs: number };
}

export class MailError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "MailError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class MailAccountStore {
  constructor(
    private readonly store: HearthStore,
    private readonly secretBox: SecretBox
  ) {}

  list(): MailAccountRecord[] {
    const raw = this.store.getAppSetting(ACCOUNTS_KEY);
    if (!raw) return [];
    try {
      const value = JSON.parse(raw) as unknown;
      if (!Array.isArray(value)) return [];
      return value.filter(isRecord).map((record) => normalizeRecord(record)).filter((record): record is MailAccountRecord => record !== null);
    } catch {
      return [];
    }
  }

  views(): MailAccountView[] {
    return this.list().map((record) => viewAccount(record));
  }

  get(id: string): MailAccountRecord {
    const account = this.list().find((item) => item.id === id);
    if (!account) throw new MailError("MAIL_ACCOUNT_NOT_FOUND", "邮件账户不存在", 404);
    return account;
  }

  create(input: MailAccountInput): MailAccountRecord {
    const normalized = validateInput(input, true);
    const now = new Date().toISOString();
    const record: MailAccountRecord = {
      id: randomUUID(),
      name: normalized.name,
      fromName: normalized.fromName,
      fromAddress: normalized.fromAddress,
      smtp: {
        ...normalized.smtp,
        passwordCipher: this.secretBox.encrypt(requirePassword(input.smtp.password, "SMTP"))
      },
      imap: {
        ...normalized.imap,
        passwordCipher: this.secretBox.encrypt(requirePassword(input.imap.password, "IMAP"))
      },
      syncEnabled: normalized.syncEnabled,
      syncIntervalMinutes: normalized.syncIntervalMinutes,
      createdAt: now,
      updatedAt: now
    };
    this.store.setAppSetting(ACCOUNTS_KEY, JSON.stringify([...this.list(), record]));
    return record;
  }

  update(id: string, input: MailAccountInput): MailAccountRecord {
    const current = this.get(id);
    const normalized = validateInput(input, false);
    const next: MailAccountRecord = {
      ...current,
      name: normalized.name,
      fromName: normalized.fromName,
      fromAddress: normalized.fromAddress,
      smtp: {
        ...normalized.smtp,
        passwordCipher: input.smtp.password?.trim()
          ? this.secretBox.encrypt(input.smtp.password.trim())
          : current.smtp.passwordCipher
      },
      imap: {
        ...normalized.imap,
        passwordCipher: input.imap.password?.trim()
          ? this.secretBox.encrypt(input.imap.password.trim())
          : current.imap.passwordCipher
      },
      syncEnabled: normalized.syncEnabled,
      syncIntervalMinutes: normalized.syncIntervalMinutes,
      updatedAt: new Date().toISOString()
    };
    this.store.setAppSetting(ACCOUNTS_KEY, JSON.stringify(this.list().map((account) => account.id === id ? next : account)));
    return next;
  }

  remove(id: string): void {
    this.get(id);
    this.store.setAppSetting(ACCOUNTS_KEY, JSON.stringify(this.list().filter((account) => account.id !== id)));
  }

  runtime(id: string): MailAccountRuntime {
    const account = this.get(id);
    return {
      ...account,
      smtp: { ...account.smtp, password: this.decrypt(account.smtp.passwordCipher, "SMTP") },
      imap: { ...account.imap, password: this.decrypt(account.imap.passwordCipher, "IMAP") }
    };
  }

  private decrypt(cipher: string, label: string): string {
    try {
      return this.secretBox.decrypt(cipher);
    } catch {
      throw new MailError("MAIL_SECRET_UNREADABLE", `${label} 密码无法解密，请重新填写`, 409);
    }
  }
}

export class EmailService {
  readonly accounts: MailAccountStore;
  private readonly smtpFactory: MailSmtpFactory;
  private readonly imapFactory: MailImapFactory;
  private readonly now: () => Date;

  constructor(options: {
    store: HearthStore;
    secretBox: SecretBox;
    smtpFactory?: MailSmtpFactory;
    imapFactory?: MailImapFactory;
    now?: () => Date;
  }) {
    this.accounts = new MailAccountStore(options.store, options.secretBox);
    this.smtpFactory = options.smtpFactory ?? defaultSmtpFactory;
    this.imapFactory = options.imapFactory ?? defaultImapFactory;
    this.now = options.now ?? (() => new Date());
  }

  list(): MailAccountView[] {
    return this.accounts.views();
  }

  create(input: MailAccountInput): MailAccountView {
    return viewAccount(this.accounts.create(input));
  }

  update(id: string, input: MailAccountInput): MailAccountView {
    return viewAccount(this.accounts.update(id, input));
  }

  remove(id: string): void {
    this.accounts.remove(id);
  }

  async test(id: string): Promise<MailTestResult> {
    const account = this.accounts.runtime(id);
    return this.testRuntime(account);
  }

  async testRuntime(account: MailAccountRuntime): Promise<MailTestResult> {
    const smtp = await this.testSmtp(account);
    const imap = await this.testImap(account);
    return { ok: smtp.ok && imap.ok, smtp, imap };
  }

  async send(accountId: string, message: Omit<MailMessage, "from">): Promise<MailSendResult> {
    const account = this.accounts.runtime(accountId);
    const transport = this.smtpFactory(account);
    try {
      const result = await transport.sendMail({ ...message, from: account.fromName ? `${account.fromName} <${account.fromAddress}>` : account.fromAddress });
      return {
        messageId: result.messageId,
        accepted: result.accepted.map(String),
        rejected: result.rejected.map(String),
        response: result.response
      };
    } finally {
      try {
        transport.close?.();
      } catch {
        // Closing a broken SMTP connection should not mask the send result.
      }
    }
  }

  private async testSmtp(account: MailAccountRuntime): Promise<MailTestResult["smtp"]> {
    const started = Date.now();
    let transport: MailSmtpTransport | null = null;
    try {
      transport = this.smtpFactory(account);
      await transport.verify();
      return { ok: true, error: null, elapsedMs: Date.now() - started };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - started };
    } finally {
      try {
        transport?.close?.();
      } catch {
        // Best effort.
      }
    }
  }

  private async testImap(account: MailAccountRuntime): Promise<MailTestResult["imap"]> {
    const started = Date.now();
    let transport: MailImapTransport | null = null;
    try {
      transport = this.imapFactory(account);
      await transport.connect();
      return { ok: true, error: null, elapsedMs: Date.now() - started };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - started };
    } finally {
      try {
        await transport?.logout();
      } catch {
        // Best effort.
      }
    }
  }
}

function defaultSmtpFactory(account: MailAccountRuntime): MailSmtpTransport {
  const transport = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.smtp.user, pass: account.smtp.password }
  });
  return {
    verify: () => transport.verify(),
    sendMail: (message) => transport.sendMail(message).then((result) => ({
      messageId: result.messageId ?? "",
      accepted: result.accepted.map(String),
      rejected: result.rejected.map(String),
      response: result.response
    })),
    close: () => transport.close()
  };
}

function defaultImapFactory(account: MailAccountRuntime): MailImapTransport {
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: account.imap.user, pass: account.imap.password },
    logger: false
  });
  return {
    connect: () => client.connect(),
    logout: () => client.logout()
  };
}

function validateInput(input: MailAccountInput, requireSecrets: boolean): {
  name: string;
  fromName: string;
  fromAddress: string;
  smtp: Omit<MailServerRecord, "passwordCipher">;
  imap: Omit<MailServerRecord, "passwordCipher">;
  syncEnabled: boolean;
  syncIntervalMinutes: number;
} {
  const name = clean(input.name, 80, "账户名称");
  const fromName = clean(input.fromName, 120, "发件人名称");
  const fromAddress = clean(input.fromAddress, 320, "发件人地址");
  if (!EMAIL_PATTERN.test(fromAddress)) throw new MailError("INVALID_MAIL_ADDRESS", "发件人地址格式不正确");
  const smtp = validateServer(input.smtp, "SMTP", requireSecrets);
  const imap = validateServer(input.imap, "IMAP", requireSecrets);
  const syncIntervalMinutes = input.syncIntervalMinutes ?? 15;
  if (!Number.isInteger(syncIntervalMinutes) || syncIntervalMinutes < 5 || syncIntervalMinutes > 1440) {
    throw new MailError("INVALID_SYNC_INTERVAL", "同步间隔必须在 5 到 1440 分钟之间");
  }
  return { name, fromName, fromAddress, smtp, imap, syncEnabled: input.syncEnabled ?? true, syncIntervalMinutes };
}

function validateServer(input: MailServerInput, label: string, requireSecret: boolean): Omit<MailServerRecord, "passwordCipher"> {
  const host = clean(input.host, 255, `${label} 服务器`);
  const user = clean(input.user, 320, `${label} 用户名`);
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new MailError("INVALID_MAIL_PORT", `${label} 端口必须在 1 到 65535 之间`);
  }
  if (requireSecret && !input.password?.trim()) throw new MailError("MAIL_PASSWORD_REQUIRED", `${label} 密码不能为空`);
  return { host, port: input.port, secure: input.secure, user };
}

function requirePassword(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new MailError("MAIL_PASSWORD_REQUIRED", `${label} 密码不能为空`);
  return value.trim();
}

function clean(value: string, maxLength: number, label: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new MailError("INVALID_MAIL_FIELD", `${label}不能为空`);
  if (cleaned.length > maxLength) throw new MailError("INVALID_MAIL_FIELD", `${label}过长`);
  return cleaned;
}

function viewAccount(account: MailAccountRecord): MailAccountView {
  return {
    id: account.id,
    name: account.name,
    fromName: account.fromName,
    fromAddress: account.fromAddress,
    smtp: viewServer(account.smtp),
    imap: viewServer(account.imap),
    syncEnabled: account.syncEnabled,
    syncIntervalMinutes: account.syncIntervalMinutes,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

function viewServer(server: MailServerRecord): MailServerView {
  return {
    host: server.host,
    port: server.port,
    secure: server.secure,
    user: server.user,
    hasPassword: Boolean(server.passwordCipher),
    passwordMasked: server.passwordCipher ? "••••••••" : null
  };
}

function normalizeRecord(value: Record<string, unknown>): MailAccountRecord | null {
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.fromAddress !== "string") return null;
  const smtp = normalizeServer(value.smtp);
  const imap = normalizeServer(value.imap);
  if (!smtp || !imap) return null;
  return {
    id: value.id,
    name: value.name,
    fromName: typeof value.fromName === "string" ? value.fromName : value.name,
    fromAddress: value.fromAddress,
    smtp,
    imap,
    syncEnabled: value.syncEnabled !== false,
    syncIntervalMinutes: typeof value.syncIntervalMinutes === "number" ? value.syncIntervalMinutes : 15,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString()
  };
}

function normalizeServer(value: unknown): MailServerRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.host !== "string" || typeof value.user !== "string" || typeof value.passwordCipher !== "string") return null;
  if (typeof value.port !== "number" || typeof value.secure !== "boolean") return null;
  return { host: value.host, port: value.port, secure: value.secure, user: value.user, passwordCipher: value.passwordCipher };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}