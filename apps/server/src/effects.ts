import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { ArtifactRecord, EffectRecord } from "@hearth/core";
import { EffectUncertainError } from "./approvals.ts";
import { REPO_ROOT } from "./config.ts";
import { executeGitHubEffect } from "./github.ts";
import type { EmailService } from "./email.ts";

export interface EffectExecutionContext {
  outboxRoot: string;
  getArtifact(id: string): ArtifactRecord | null;
  mail?: EmailService | undefined;
}

interface OutboxTarget {
  draftId: string;
  account: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachments: { artifactId: string; name: string; mimeType: string; sha256: string; bytes: number }[];
  transport: "local-outbox";
}

interface PreparedAttachment {
  artifactId: string;
  name: string;
  storedName: string;
  mimeType: string;
  sha256: string;
  bytes: number;
  sourcePath: string;
}

export async function executeEffect(
  effect: EffectRecord,
  context: EffectExecutionContext
): Promise<Record<string, unknown>> {
  if (effect.kind.startsWith("github.")) return executeGitHubEffect(effect);
  if (effect.kind === "outbox.local-write") return executeLocalOutboxEffect(effect, context);
  if (effect.kind === "email.smtp-send") return executeSmtpOutboxEffect(effect, context);
  throw new Error(`外部动作执行器尚未接入：${effect.kind}`);
}

function executeLocalOutboxEffect(effect: EffectRecord, context: EffectExecutionContext): Record<string, unknown> {
  const target = parseOutboxTarget(effect.target);
  const effectDir = join(context.outboxRoot, effect.id);
  const receiptPath = join(effectDir, "receipt.json");
  const messagePath = join(effectDir, "message.eml");
  const manifestPath = join(effectDir, "manifest.json");

  if (existsSync(receiptPath)) {
    const receipt = parseExistingReceipt(receiptPath);
    if (!existsSync(messagePath)) throw new EffectUncertainError("本地发件箱回执存在，但邮件文件已丢失");
    return receipt;
  }
  if (existsSync(effectDir)) {
    throw new EffectUncertainError("本地发件箱目录已经存在，但没有可核对的回执");
  }

  const attachments = prepareAttachments(target, context);
  const message = buildMessage(target, effect);
  const manifest = {
    format: "hearth-local-outbox",
    version: 1,
    effectId: effect.id,
    idempotencyKey: effect.idempotencyKey,
    draftId: target.draftId,
    account: target.account,
    to: target.to,
    cc: target.cc,
    bcc: target.bcc,
    subject: target.subject,
    delivery: "not_sent" as const,
    createdAt: effect.createdAt,
    attachments: attachments.map((attachment) => ({
      artifactId: attachment.artifactId,
      name: attachment.name,
      storedName: attachment.storedName,
      mimeType: attachment.mimeType,
      sha256: attachment.sha256,
      bytes: attachment.bytes
    }))
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const messageBuffer = Buffer.from(message, "utf8");
  const messageSha256 = createHash("sha256").update(messageBuffer).digest("hex");

  try {
    mkdirSync(join(effectDir, "attachments"), { recursive: true });
    for (const attachment of attachments) {
      copyFileSync(attachment.sourcePath, join(effectDir, "attachments", attachment.storedName));
    }
    writeFileSync(messagePath, messageBuffer, { flag: "wx" });
    writeFileSync(manifestPath, manifestJson, { flag: "wx" });
    const receipt = {
      transport: "local-outbox" as const,
      delivery: "not_sent" as const,
      status: "written-local" as const,
      messagePath: displayPath(messagePath),
      manifestPath: displayPath(manifestPath),
      directoryPath: displayPath(effectDir),
      messageSha256,
      bytes: messageBuffer.byteLength,
      attachmentCount: attachments.length,
      idempotencyKey: effect.idempotencyKey,
      writtenAt: new Date().toISOString()
    };
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    return receipt;
  } catch (error) {
    throw new EffectUncertainError(
      `写入本地发件箱时中断，文件可能只写入一部分：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

interface SmtpOutboxTarget {
  draftId: string;
  accountId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachments: OutboxTarget["attachments"];
  transport: "smtp";
}

async function executeSmtpOutboxEffect(effect: EffectRecord, context: EffectExecutionContext): Promise<Record<string, unknown>> {
  const target = parseSmtpTarget(effect.target);
  if (!context.mail) throw new Error("邮件发送服务尚未启动");
  const effectDir = join(context.outboxRoot, effect.id);
  const receiptPath = join(effectDir, "receipt.json");
  const sendingPath = join(effectDir, "sending.json");

  if (existsSync(receiptPath)) return parseExistingReceipt(receiptPath);
  if (existsSync(effectDir)) {
    throw new EffectUncertainError("邮件发送目录已经存在，但没有可核对的回执；先到邮箱核对是否已经发出");
  }

  const attachments = prepareAttachments(target, context);
  mkdirSync(effectDir, { recursive: true });
  try {
    writeFileSync(sendingPath, `${JSON.stringify({
      effectId: effect.id,
      idempotencyKey: effect.idempotencyKey,
      startedAt: new Date().toISOString()
    }, null, 2)}
`, { flag: "wx" });
  } catch (error) {
    throw new EffectUncertainError(`无法写入邮件发送标记：${error instanceof Error ? error.message : String(error)}`);
  }

  const messageId = `hearth-${effect.id}@hearth.local`;
  let result;
  try {
    result = await context.mail.send(target.accountId, {
      to: target.to,
      cc: target.cc,
      bcc: target.bcc,
      subject: target.subject,
      text: target.body,
      messageId,
      attachments: attachments.map((attachment) => ({
        filename: attachment.name,
        path: attachment.sourcePath,
        contentType: attachment.mimeType
      }))
    });
  } catch (error) {
    if (isUncertainSmtpSendError(error)) {
      throw new EffectUncertainError(`邮件发送中断，无法确认服务端是否已接受：${error instanceof Error ? error.message : String(error)}`);
    }
    rmSync(effectDir, { recursive: true, force: true });
    throw error;
  }

  const receipt = {
    transport: "smtp" as const,
    delivery: "sent" as const,
    status: "sent" as const,
    accountId: target.accountId,
    from: target.from,
    to: target.to,
    cc: target.cc,
    bcc: target.bcc,
    subject: target.subject,
    messageId: result.messageId || messageId,
    accepted: result.accepted,
    rejected: result.rejected,
    response: result.response,
    attachmentCount: attachments.length,
    idempotencyKey: effect.idempotencyKey,
    sentAt: new Date().toISOString()
  };
  try {
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}
`, { flag: "wx" });
  } catch (error) {
    throw new EffectUncertainError(`邮件已经发出，但回执写入失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return receipt;
}

function parseSmtpTarget(value: Record<string, unknown>): SmtpOutboxTarget {
  const transport = value.transport;
  if (transport !== "smtp") throw new Error("邮件发送动作的 transport 不正确");
  const attachments = Array.isArray(value.attachments) ? value.attachments : [];
  return {
    draftId: requireString(value.draftId, "draftId", 80),
    accountId: requireString(value.accountId, "accountId", 80),
    from: requireString(value.from, "from", 320),
    to: requireAddresses(value.to, "收件人"),
    cc: requireAddresses(value.cc, "抄送"),
    bcc: requireAddresses(value.bcc, "密送"),
    subject: requireString(value.subject, "subject", 500),
    body: requireBody(value.body),
    attachments: attachments.map((item, index) => {
      if (!item || typeof item !== "object") throw new Error(`附件 ${index + 1} 格式不正确`);
      const record = item as Record<string, unknown>;
      return {
        artifactId: requireString(record.artifactId, "attachmentId", 80),
        name: requireString(record.name, "attachmentName", 255),
        mimeType: requireString(record.mimeType, "attachmentMimeType", 200),
        sha256: requireString(record.sha256, "attachmentSha256", 64),
        bytes: requireNumber(record.bytes, "attachmentBytes")
      };
    }),
    transport
  };
}

function isUncertainSmtpSendError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  return !["EAUTH", "EENVELOPE", "EMESSAGE", "EACCES", "ECONNREFUSED", "ENOTFOUND", "EDNS"].includes(code);
}

function parseOutboxTarget(value: Record<string, unknown>): OutboxTarget {
  const draftId = requireString(value.draftId, "draftId", 80);
  const transport = value.transport;
  if (transport !== "local-outbox") throw new Error("本地发件箱动作的 transport 不正确");
  const attachments = Array.isArray(value.attachments) ? value.attachments : [];
  return {
    draftId,
    account: requireString(value.account, "account", 200),
    to: requireAddresses(value.to, "收件人"),
    cc: requireAddresses(value.cc, "抄送"),
    bcc: requireAddresses(value.bcc, "密送"),
    subject: requireString(value.subject, "subject", 500),
    body: requireBody(value.body),
    attachments: attachments.map((item, index) => {
      if (!item || typeof item !== "object") throw new Error(`附件 ${index + 1} 格式不正确`);
      const record = item as Record<string, unknown>;
      return {
        artifactId: requireString(record.artifactId, "attachmentId", 80),
        name: requireString(record.name, "attachmentName", 255),
        mimeType: requireString(record.mimeType, "attachmentMimeType", 200),
        sha256: requireString(record.sha256, "attachmentSha256", 64),
        bytes: requireNumber(record.bytes, "attachmentBytes")
      };
    }),
    transport
  };
}

function prepareAttachments(target: { attachments: OutboxTarget["attachments"] }, context: EffectExecutionContext): PreparedAttachment[] {
  const names = new Set<string>();
  return target.attachments.map((attachment, index) => {
    const artifact = context.getArtifact(attachment.artifactId);
    if (!artifact) throw new Error(`附件不存在：${attachment.name}`);
    if (!existsSync(artifact.absolutePath)) throw new Error(`附件文件不可用：${attachment.name}`);
    const bytes = readFileSync(artifact.absolutePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== attachment.sha256 || sha256 !== artifact.sha256) {
      throw new Error(`附件内容已经变化：${attachment.name}`);
    }
    if (bytes.byteLength !== attachment.bytes) throw new Error(`附件大小已经变化：${attachment.name}`);
    const safeName = sanitizeFileName(attachment.name || basename(artifact.absolutePath), index);
    let storedName = safeName;
    let suffix = 2;
    while (names.has(storedName.toLowerCase())) {
      storedName = `${index + 1}-${safeName}`;
      suffix += 1;
      if (suffix > 100) throw new Error("附件文件名冲突无法解决");
    }
    names.add(storedName.toLowerCase());
    return {
      artifactId: artifact.id,
      name: attachment.name,
      storedName,
      mimeType: artifact.mimeType,
      sha256,
      bytes: bytes.byteLength,
      sourcePath: artifact.absolutePath
    };
  });
}

function buildMessage(target: OutboxTarget, effect: EffectRecord): string {
  const headers = [
    `Date: ${new Date(effect.createdAt).toUTCString()}`,
    `From: ${headerValue(target.account)}`,
    `To: ${target.to.map(headerValue).join(", ")}`,
    ...(target.cc.length > 0 ? [`Cc: ${target.cc.map(headerValue).join(", ")}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(target.subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "X-Hearth-Transport: local-outbox",
    `X-Hearth-Idempotency-Key: ${headerValue(effect.idempotencyKey)}`
  ];
  const encodedBody = Buffer.from(target.body.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/.{1,76}/g, "$&\r\n")
    .trimEnd();
  return `${headers.join("\r\n")}\r\n\r\n${encodedBody}\r\n`;
}

function parseExistingReceipt(path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object") throw new Error("回执不是对象");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new EffectUncertainError(`本地发件箱回执无法读取：${error instanceof Error ? error.message : String(error)}`);
  }
}

function displayPath(path: string): string {
  return relative(REPO_ROOT, path).replaceAll("\\", "/");
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value || value.length > maxLength || /[\r\n]/.test(value)) {
    throw new Error(`本地发件箱字段 ${field} 不正确`);
  }
  return value;
}

function requireBody(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200_000) {
    throw new Error("本地发件箱字段 body 不正确");
  }
  return value;
}

function requireAddresses(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label}格式不正确`);
  return value.map((item) => requireString(item, label, 320));
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`本地发件箱字段 ${field} 不正确`);
  }
  return value;
}

function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function sanitizeFileName(name: string, index: number): string {
  const cleaned = basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : `attachment-${index + 1}`;
}
