import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactRecord, EffectRecord } from "@hearth/core";
import { afterEach, describe, expect, it } from "vitest";
import { EffectUncertainError } from "./approvals.ts";
import { executeEffect } from "./effects.ts";

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
