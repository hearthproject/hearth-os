import { randomUUID } from "node:crypto";
import type { ApprovalGrant } from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";

type Row = Record<string, unknown>;

export class ApprovalGrantRepository {
  private readonly store: HearthStore;

  constructor(store: HearthStore) {
    this.store = store;
  }

  list(includeRevoked = false): ApprovalGrant[] {
    const rows = includeRevoked
      ? this.store.db.prepare("SELECT * FROM approval_grants ORDER BY created_at DESC").all() as Row[]
      : this.store.db.prepare("SELECT * FROM approval_grants WHERE revoked_at IS NULL ORDER BY created_at DESC").all() as Row[];
    return rows.map(grantFromRow);
  }

  find(service: string, action: string, scope: Record<string, unknown> = {}): ApprovalGrant | null {
    const row = this.store.db.prepare(
      "SELECT * FROM approval_grants WHERE service = ? AND action = ? AND scope_json = ? AND revoked_at IS NULL LIMIT 1"
    ).get(service, action, JSON.stringify(scope)) as Row | undefined;
    return row ? grantFromRow(row) : null;
  }

  create(service: string, action: string, scope: Record<string, unknown> = {}): ApprovalGrant {
    const id = randomUUID();
    const now = new Date().toISOString();
    const scopeJson = JSON.stringify(scope);
    this.store.db.prepare(
      `INSERT INTO approval_grants (id, service, action, scope_json, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(service, action, scope_json) WHERE revoked_at IS NULL DO UPDATE SET last_used_at = NULL`
    ).run(id, service, action, scopeJson, now);
    const row = this.store.db.prepare(
      "SELECT * FROM approval_grants WHERE service = ? AND action = ? AND scope_json = ? AND revoked_at IS NULL LIMIT 1"
    ).get(service, action, scopeJson) as Row;
    return grantFromRow(row);
  }

  touch(id: string): void {
    this.store.db.prepare("UPDATE approval_grants SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  revoke(id: string): boolean {
    const result = this.store.db.prepare(
      "UPDATE approval_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"
    ).run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  revokeAll(): void {
    this.store.db.prepare("UPDATE approval_grants SET revoked_at = ? WHERE revoked_at IS NULL").run(new Date().toISOString());
  }
}

function grantFromRow(row: Row): ApprovalGrant {
  let scope: Record<string, unknown> = {};
  try {
    scope = JSON.parse(String(row.scope_json ?? "{}")) as Record<string, unknown>;
  } catch {
    scope = {};
  }
  return {
    id: String(row.id),
    service: String(row.service),
    action: String(row.action),
    scope,
    createdAt: String(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at)
  };
}
