import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";
import {
  EmailService,
  MailAccountStore,
  type MailAccountInput,
  type MailImapFactory,
  type MailSmtpFactory
} from "./email.ts";
import { SecretBox } from "./secrets.ts";

const INPUT: MailAccountInput = {
  name: "工作邮箱",
  fromName: "Hearth",
  fromAddress: "hearth@example.com",
  smtp: { host: "smtp.example.com", port: 465, secure: true, user: "hearth@example.com", password: "smtp-secret" },
  imap: { host: "imap.example.com", port: 993, secure: true, user: "hearth@example.com", password: "imap-secret" },
  syncEnabled: true,
  syncIntervalMinutes: 15
};

describe("MailAccountStore", () => {
  let store: HearthStore;
  let accounts: MailAccountStore;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    accounts = new MailAccountStore(store, new SecretBox(Buffer.alloc(32, 13)));
  });

  afterEach(() => store.close());

  it("encrypts both passwords and masks them in views", () => {
    const created = accounts.create(INPUT);
    const raw = store.getAppSetting("mail.accounts.v1") ?? "";
    expect(raw).not.toContain("smtp-secret");
    expect(raw).not.toContain("imap-secret");
    expect(accounts.views()[0]).toMatchObject({
      name: "工作邮箱",
      smtp: { host: "smtp.example.com", hasPassword: true, passwordMasked: "••••••••" },
      imap: { host: "imap.example.com", hasPassword: true }
    });
    expect(accounts.runtime(created.id).smtp.password).toBe("smtp-secret");
    expect(accounts.runtime(created.id).imap.password).toBe("imap-secret");
  });

  it("keeps existing passwords when an update leaves them blank", () => {
    const created = accounts.create(INPUT);
    accounts.update(created.id, {
      ...INPUT,
      name: "工作邮箱 2",
      smtp: { ...INPUT.smtp, password: "" },
      imap: { ...INPUT.imap, password: "" }
    });
    expect(accounts.get(created.id).name).toBe("工作邮箱 2");
    expect(accounts.runtime(created.id).smtp.password).toBe("smtp-secret");
    expect(accounts.runtime(created.id).imap.password).toBe("imap-secret");
  });

  it("requires passwords on create and validates the address", () => {
    expect(() => accounts.create({ ...INPUT, smtp: { ...INPUT.smtp, password: "" } })).toThrow(/SMTP 密码不能为空/);
    expect(() => accounts.create({ ...INPUT, fromAddress: "not-an-email" })).toThrow(/发件人地址/);
  });
});

describe("EmailService", () => {
  let store: HearthStore;
  let service: EmailService;
  let smtpOk: boolean;
  let imapOk: boolean;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    smtpOk = true;
    imapOk = true;
    const smtpFactory: MailSmtpFactory = () => ({
      async verify() {
        if (!smtpOk) throw new Error("smtp refused");
      },
      async sendMail() {
        return { messageId: "msg-1", accepted: ["to@example.com"], rejected: [], response: "250 OK" };
      }
    });
    const imapFactory: MailImapFactory = () => ({
      async connect() {
        if (!imapOk) throw new Error("imap refused");
      },
      async logout() {}
    });
    service = new EmailService({
      store,
      secretBox: new SecretBox(Buffer.alloc(32, 17)),
      smtpFactory,
      imapFactory
    });
  });

  afterEach(() => store.close());

  it("tests SMTP and IMAP independently", async () => {
    const account = service.create(INPUT);
    expect(await service.test(account.id)).toMatchObject({ ok: true, smtp: { ok: true }, imap: { ok: true } });

    smtpOk = false;
    const failedSmtp = await service.test(account.id);
    expect(failedSmtp).toMatchObject({ ok: false, smtp: { ok: false, error: "smtp refused" }, imap: { ok: true } });

    smtpOk = true;
    imapOk = false;
    const failedImap = await service.test(account.id);
    expect(failedImap).toMatchObject({ ok: false, smtp: { ok: true }, imap: { ok: false, error: "imap refused" } });
  });
});

describe("Mail API", () => {
  let store: HearthStore;
  let root: string;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    root = mkdtempSync(join(tmpdir(), "hearth-mail-api-"));
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function app() {
    return buildServer({
      store,
      serveWeb: false,
      masterKeyPath: join(root, "master.key"),
      attachmentRoot: join(root, "attachments"),
      mailSmtpFactory: () => ({
        async verify() {},
        async sendMail() {
          return { messageId: "msg-1", accepted: [], rejected: [], response: "250 OK" };
        }
      }),
      mailImapFactory: () => ({
        async connect() {},
        async logout() {}
      })
    });
  }

  it("creates, lists, updates, tests, and deletes accounts without exposing passwords", async () => {
    const server = await app();
    try {
      const created = await server.inject({ method: "POST", url: "/api/mail/accounts", payload: INPUT });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.body).not.toContain("smtp-secret");
      expect(created.body).not.toContain("imap-secret");
      const id = created.json().account.id as string;
      expect(created.json().account).toMatchObject({
        fromAddress: "hearth@example.com",
        smtp: { hasPassword: true, passwordMasked: "••••••••" }
      });

      const listed = await server.inject({ method: "GET", url: "/api/mail/accounts" });
      expect(listed.json().accounts).toHaveLength(1);

      const tested = await server.inject({ method: "POST", url: `/api/mail/accounts/${id}/test` });
      expect(tested.statusCode, tested.body).toBe(200);
      expect(tested.json()).toMatchObject({ ok: true });

      const updated = await server.inject({
        method: "PATCH",
        url: `/api/mail/accounts/${id}`,
        payload: { ...INPUT, name: "新名称", smtp: { ...INPUT.smtp, password: "" } }
      });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.json().account.name).toBe("新名称");

      const removed = await server.inject({ method: "DELETE", url: `/api/mail/accounts/${id}` });
      expect(removed.statusCode).toBe(204);
      expect((await server.inject({ method: "GET", url: "/api/mail/accounts" })).json().accounts).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("rejects incomplete accounts", async () => {
    const server = await app();
    try {
      const invalid = await server.inject({
        method: "POST",
        url: "/api/mail/accounts",
        payload: { ...INPUT, smtp: { ...INPUT.smtp, password: "" } }
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });
});