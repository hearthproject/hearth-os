import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactRecord, EffectRecord } from "@hearth/core";
import { afterEach, describe, expect, it } from "vitest";
import { EffectUncertainError } from "./approvals.ts";
import { executeEffect } from "./effects.ts";
import type { EmailService, MailMessage } from "./email.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-outbox-effect-"));
  tempDirs.push(dir);
  return dir;
}

function fixture() {
  const root = tempDir();
  const attachmentPath = join(root, "notes.txt");
  writeFileSync(attachmentPath, "attached notes\n", "utf8");
  const attachmentBytes = readFileSync(attachmentPath);
  const attachmentHash = createHash("sha256").update(attachmentBytes).digest("hex");
  const artifact: ArtifactRecord = {
    id: "artifact-1",
    taskId: "task-1",
    runId: "run-1",
    relativePath: "artifacts/notes.txt",
    absolutePath: attachmentPath,
    mimeType: "text/plain",
    sha256: attachmentHash,
    bytes: attachmentBytes.byteLength,
    createdAt: "2026-11-06T01:00:00.000Z"
  };
  const effect: EffectRecord = {
    id: "effect-1",
    taskId: "task-1",
    approvalId: "approval-1",
    kind: "outbox.local-write",
    idempotencyKey: "approval:approval-1:hash",
    status: "executing",
    target: {
      draftId: "draft-1",
      account: "local-test",
      to: ["reviewer@example.test"],
      cc: [],
      bcc: ["audit@example.test"],
      subject: "Weekly update",
      body: "Hello\nThis was written locally.",
      attachments: [{
        artifactId: artifact.id,
        name: "notes.txt",
        mimeType: artifact.mimeType,
        sha256: artifact.sha256,
        bytes: artifact.bytes
      }],
      transport: "local-outbox"
    },
    receipt: null,
    error: null,
    createdAt: "2026-11-06T01:02:00.000Z",
    updatedAt: "2026-11-06T01:02:00.000Z"
  };
  return { root, effect, artifact };
}


describe("smtp outbox effect", () => {
  function smtpFixture() {
    const { root, effect, artifact } = fixture();
    return {
      root,
      artifact,
      effect: {
        ...effect,
        kind: "email.smtp-send",
        target: {
          draftId: "draft-1",
          accountId: "acct-1",
          from: "sender@example.com",
          to: ["reviewer@example.test"],
          cc: [],
          bcc: ["audit@example.test"],
          subject: "Weekly update",
          body: "Hello from SMTP.",
          attachments: [{
            artifactId: artifact.id,
            name: "notes.txt",
            mimeType: artifact.mimeType,
            sha256: artifact.sha256,
            bytes: artifact.bytes
          }],
          transport: "smtp"
        }
      } satisfies EffectRecord
    };
  }

  it("sends through the injected mail service and writes a sent receipt", async () => {
    const { root, effect, artifact } = smtpFixture();
    const sent: MailMessage[] = [];
    const mail = {
      async send(_accountId: string, message: MailMessage) {
        sent.push(message);
        return { messageId: "server-msg-1", accepted: ["reviewer@example.test"], rejected: [], response: "250 OK" };
      }
    } as unknown as EmailService;
    const outboxRoot = join(root, "outbox");
    const receipt = await executeEffect(effect, {
      outboxRoot,
      getArtifact: () => artifact,
      mail
    });

    expect(receipt).toMatchObject({
      transport: "smtp",
      delivery: "sent",
      status: "sent",
      accountId: "acct-1",
      messageId: "server-msg-1",
      accepted: ["reviewer@example.test"]
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: ["reviewer@example.test"],
      subject: "Weekly update",
      text: "Hello from SMTP.",
      messageId: `hearth-${effect.id}@hearth.local`
    });
    expect(sent[0]?.attachments[0]).toMatchObject({ filename: "notes.txt" });
    expect(existsSync(join(outboxRoot, effect.id, "receipt.json"))).toBe(true);
    expect(existsSync(join(outboxRoot, effect.id, "sending.json"))).toBe(true);
  });

  it("reuses a sent receipt instead of sending twice", async () => {
    const { root, effect, artifact } = smtpFixture();
    let calls = 0;
    const mail = {
      async send() {
        calls += 1;
        return { messageId: "server-msg-1", accepted: [], rejected: [], response: "250 OK" };
      }
    } as unknown as EmailService;
    const context = { outboxRoot: join(root, "outbox"), getArtifact: () => artifact, mail };
    const first = await executeEffect(effect, context);
    const second = await executeEffect(effect, context);
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it("marks a post-send network failure uncertain and a pre-send auth failure safe", async () => {
    const uncertain = smtpFixture();
    const uncertainMail = {
      async send() {
        throw new Error("socket hang up");
      }
    } as unknown as EmailService;
    await expect(executeEffect(uncertain.effect, {
      outboxRoot: join(uncertain.root, "outbox"),
      getArtifact: () => uncertain.artifact,
      mail: uncertainMail
    })).rejects.toBeInstanceOf(EffectUncertainError);

    const auth = smtpFixture();
    const authError = Object.assign(new Error("auth failed"), { code: "EAUTH" });
    const authMail = {
      async send() {
        throw authError;
      }
    } as unknown as EmailService;
    const authRoot = join(auth.root, "outbox");
    await expect(executeEffect(auth.effect, { outboxRoot: authRoot, getArtifact: () => auth.artifact, mail: authMail }))
      .rejects.toThrow("auth failed");
    expect(existsSync(join(authRoot, auth.effect.id, "sending.json"))).toBe(false);
  });
});

describe("local outbox effect", () => {
  it("writes a message package and returns an explicit not-sent receipt", async () => {
    const { root, effect, artifact } = fixture();
    const outboxRoot = join(root, "outbox");
    const receipt = await executeEffect(effect, {
      outboxRoot,
      getArtifact: (id) => id === artifact.id ? artifact : null
    });

    expect(receipt).toMatchObject({
      transport: "local-outbox",
      delivery: "not_sent",
      status: "written-local",
      attachmentCount: 1,
      idempotencyKey: effect.idempotencyKey
    });
    expect(existsSync(join(outboxRoot, effect.id, "message.eml"))).toBe(true);
    expect(existsSync(join(outboxRoot, effect.id, "manifest.json"))).toBe(true);
    expect(existsSync(join(outboxRoot, effect.id, "attachments", "notes.txt"))).toBe(true);
    expect(existsSync(join(outboxRoot, effect.id, "receipt.json"))).toBe(true);
    const message = readFileSync(join(outboxRoot, effect.id, "message.eml"), "utf8");
    expect(message).toContain("X-Hearth-Transport: local-outbox");
    expect(message).not.toContain("Bcc:");
    const manifest = JSON.parse(readFileSync(join(outboxRoot, effect.id, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ delivery: "not_sent", draftId: "draft-1" });
  });

  it("reuses a receipt rather than writing a second package", async () => {
    const { root, effect, artifact } = fixture();
    const context = { outboxRoot: join(root, "outbox"), getArtifact: () => artifact };
    const first = await executeEffect(effect, context);
    const second = await executeEffect(effect, context);
    expect(second).toEqual(first);
    expect(existsSync(join(context.outboxRoot, effect.id, "receipt.json"))).toBe(true);
  });

  it("fails closed when an attachment changed or a directory has no receipt", async () => {
    const { root, effect, artifact } = fixture();
    const outboxRoot = join(root, "outbox");
    await expect(executeEffect(effect, {
      outboxRoot,
      getArtifact: () => ({ ...artifact, sha256: "0".repeat(64) })
    })).rejects.toThrow("附件内容已经变化");

    mkdirSync(join(outboxRoot, effect.id), { recursive: true });
    await expect(executeEffect(effect, { outboxRoot, getArtifact: () => artifact }))
      .rejects.toBeInstanceOf(EffectUncertainError);
  });
});
