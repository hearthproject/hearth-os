import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BackupRecord } from "@hearth/core";
import { CURRENT_SCHEMA_VERSION, HearthStore } from "@hearth/eventlog";
import type { HearthService } from "./service.ts";

const BACKUP_FORMAT = "hearth-backup";
const BACKUP_VERSION = 1;
const CIPHER = "aes-256-gcm";
const KDF_NAME = "scrypt";
const KDF_N = 32_768;
const KDF_R = 8;
const KDF_P = 1;
const KEY_BYTES = 32;
const MIN_PASSPHRASE_LENGTH = 12;
const MAX_ENVELOPE_BYTES = 512 * 1024 * 1024;

const LOCAL_ONLY_TABLES = new Set([
  "backup_records",
  "maintenance_runs",
  "task_leases",
  "connection_sessions",
  "connection_outbox",
  "pairing_requests",
  "desktop_sessions",
  "desktop_frames",
  "desktop_commands"
]);

const PRESERVED_LOCAL_TABLES = new Set(["backup_records", "maintenance_runs"]);

const PRESERVED_META_KEYS = new Set(["instanceId", "createdAt", "security.killSwitch"]);

export const BACKUP_SCOPE = {
  includes: [
    "SQLite 数据库中的任务、执行、审批、动作、产物元数据、来源元数据、发件箱草稿、记忆、方法与同步记录",
    "设置、安全审计与事件日志",
    "由用户口令加密保护的本机 master key（仅在归档解密后可见）"
  ],
  excludes: [
    "产物正文与任务工作区",
    "来源抽取的正文文件",
    "发件箱附件文件",
    "设备截图与桌面会话临时文件",
    "没有写入 Hearth 的外部服务数据"
  ]
} as const;

export interface BackupEnvelope {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  cipher: typeof CIPHER;
  kdf: {
    name: typeof KDF_NAME;
    salt: string;
    N: number;
    r: number;
    p: number;
    keyBytes: number;
  };
  iv: string;
  tag: string;
  payload: string;
}

interface BackupPayload {
  format: "hearth-backup-payload";
  version: number;
  createdAt: string;
  source: {
    instanceId: string;
    schemaVersion: number;
    appMeta: Record<string, string>;
  };
  scope: typeof BACKUP_SCOPE;
  database: {
    sha256: string;
    bytes: number;
    data: string;
  };
  masterKey: string | null;
  counts: Record<string, number>;
}

export interface BackupView {
  id: string;
  kind: string;
  bytes: number;
  sha256: string;
  createdAt: string;
}

export interface BackupSnapshot {
  records: BackupView[];
  scope: typeof BACKUP_SCOPE;
  encryption: {
    cipher: typeof CIPHER;
    kdf: typeof KDF_NAME;
    minimumPassphraseLength: number;
  };
}

export interface RestoreResult {
  restoredAt: string;
  sourceInstanceId: string;
  schemaVersion: number;
  counts: Record<string, number>;
  masterKeyRestored: boolean;
  warnings: string[];
}

export class BackupError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "BackupError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface BackupServiceOptions {
  service: HearthService;
  backupRoot: string;
  masterKeyPath: string;
  clock?: () => Date;
}

export class BackupService {
  private readonly service: HearthService;
  private readonly backupRoot: string;
  private readonly masterKeyPath: string;
  private readonly clock: () => Date;

  constructor(options: BackupServiceOptions) {
    this.service = options.service;
    this.backupRoot = resolve(options.backupRoot);
    this.masterKeyPath = resolve(options.masterKeyPath);
    this.clock = options.clock ?? (() => new Date());
  }

  create(passphrase: string): BackupRecord {
    this.validatePassphrase(passphrase);
    mkdirSync(this.backupRoot, { recursive: true });
    const createdAt = this.clock().toISOString();
    const id = randomUUID();
    const snapshotPath = join(tmpdir(), `hearth-backup-${id}.sqlite`);
    try {
      this.service.store.db.exec(`VACUUM INTO '${escapeSqlString(snapshotPath)}'`);
      const database = readFileSync(snapshotPath);
      const payload: BackupPayload = {
        format: "hearth-backup-payload",
        version: BACKUP_VERSION,
        createdAt,
        source: {
          instanceId: this.service.store.instanceId,
          schemaVersion: this.service.store.getAppMeta().schemaVersion,
          appMeta: this.readAppMeta()
        },
        scope: BACKUP_SCOPE,
        database: {
          sha256: sha256(database),
          bytes: database.byteLength,
          data: database.toString("base64")
        },
        masterKey: this.readMasterKey(),
        counts: this.databaseCounts(this.service.store)
      };
      const envelope = seal(JSON.stringify(payload), passphrase, createdAt);
      const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
      const stamp = createdAt.replace(/[:.]/g, "-");
      const filePath = join(this.backupRoot, `hearth-${stamp}-${id.slice(0, 8)}.hearth-backup`);
      writeFileAtomic(filePath, bytes);
      return this.service.store.addBackupRecord({
        id,
        kind: "encrypted-database",
        path: filePath,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        createdAt
      });
    } finally {
      rmSync(snapshotPath, { force: true });
    }
  }

  snapshot(): BackupSnapshot {
    return {
      records: this.service.store.listBackupRecords().map((record) => ({
        id: record.id,
        kind: record.kind,
        bytes: record.bytes,
        sha256: record.sha256,
        createdAt: record.createdAt
      })),
      scope: BACKUP_SCOPE,
      encryption: {
        cipher: CIPHER,
        kdf: KDF_NAME,
        minimumPassphraseLength: MIN_PASSPHRASE_LENGTH
      }
    };
  }

  getRecord(id: string): BackupRecord {
    const record = this.service.store.getBackupRecord(id);
    if (!record || record.kind !== "encrypted-database") {
      throw new BackupError("BACKUP_NOT_FOUND", "备份不存在", 404);
    }
    const path = resolve(record.path);
    const relativePath = relative(this.backupRoot, path);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new BackupError("BACKUP_PATH_INVALID", "备份文件路径无效", 409);
    }
    if (!existsSync(path)) throw new BackupError("BACKUP_FILE_MISSING", "备份文件已不在本机", 410);
    return record;
  }

  readEnvelope(id: string): { record: BackupRecord; text: string } {
    const record = this.getRecord(id);
    const text = readFileSync(record.path, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_ENVELOPE_BYTES) {
      throw new BackupError("BACKUP_TOO_LARGE", "备份文件超过可恢复大小限制", 413);
    }
    return { record, text };
  }

  restoreRecord(id: string, passphrase: string): RestoreResult {
    return this.restoreEnvelope(this.readEnvelope(id).text, passphrase);
  }

  restoreUploadedEnvelope(text: string, passphrase: string): RestoreResult {
    return this.restoreEnvelope(text, passphrase);
  }

  private restoreEnvelope(text: string, passphrase: string): RestoreResult {
    this.validatePassphrase(passphrase);
    if (!text || Buffer.byteLength(text, "utf8") > MAX_ENVELOPE_BYTES) {
      throw new BackupError("BACKUP_INVALID", "备份文件为空或超过可恢复大小限制", 400);
    }
    const payload = this.openEnvelope(text, passphrase);
    if (payload.source.schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new BackupError(
        "BACKUP_SCHEMA_TOO_NEW",
        `备份 schema ${payload.source.schemaVersion} 高于当前支持的 ${CURRENT_SCHEMA_VERSION}`,
        409
      );
    }
    const database = Buffer.from(payload.database.data, "base64");
    if (database.byteLength !== payload.database.bytes || sha256(database) !== payload.database.sha256) {
      throw new BackupError("BACKUP_CHECKSUM_MISMATCH", "备份数据库校验失败", 409);
    }

    const candidatePath = join(tmpdir(), `hearth-restore-${randomUUID()}.sqlite`);
    let candidate: HearthStore | null = null;
    try {
      writeFileSync(candidatePath, database, { mode: 0o600 });
      const probe = new DatabaseSync(candidatePath);
      const version = Number((probe.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
      probe.close();
      if (version > CURRENT_SCHEMA_VERSION) {
        throw new BackupError("BACKUP_SCHEMA_TOO_NEW", "备份数据库的 schema 高于当前应用", 409);
      }
      candidate = new HearthStore(candidatePath);
      assertIntegrity(candidate.db);
      candidate.rebuildProjections();
      assertIntegrity(candidate.db);
      const counts = this.databaseCounts(candidate);
      const preserved = this.preservedMeta();
      this.replaceDatabase(candidate, preserved);
      let masterKeyRestored = false;
      try {
        masterKeyRestored = this.restoreMasterKey(payload.masterKey);
      } catch {
        masterKeyRestored = false;
      }
      return {
        restoredAt: this.clock().toISOString(),
        sourceInstanceId: payload.source.instanceId,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        counts,
        masterKeyRestored,
        warnings: [
          ...(masterKeyRestored ? [] : ["本机 master key 未由该备份恢复；同步对端的加密令牌可能需要重新登记。"]),
          "产物正文、来源正文、发件箱附件、截图和任务工作区不在数据库备份内，需要另行保留。"
        ]
      };
    } catch (error) {
      if (error instanceof BackupError) throw error;
      throw new BackupError(
        "BACKUP_RESTORE_FAILED",
        error instanceof Error ? `恢复失败，已保留原数据库：${error.message}` : "恢复失败，已保留原数据库",
        500
      );
    } finally {
      candidate?.close();
      rmSync(candidatePath, { force: true });
      rmSync(`${candidatePath}-wal`, { force: true });
      rmSync(`${candidatePath}-shm`, { force: true });
    }
  }

  private openEnvelope(text: string, passphrase: string): BackupPayload {
    let envelope: BackupEnvelope;
    try {
      envelope = JSON.parse(text) as BackupEnvelope;
    } catch {
      throw new BackupError("BACKUP_INVALID", "备份文件不是有效的 Hearth 加密归档", 400);
    }
    if (envelope.format !== BACKUP_FORMAT || envelope.version !== BACKUP_VERSION || envelope.cipher !== CIPHER) {
      throw new BackupError("BACKUP_UNSUPPORTED", "备份格式或版本不受支持", 409);
    }
    if (envelope.kdf?.name !== KDF_NAME || envelope.kdf.N !== KDF_N || envelope.kdf.r !== KDF_R || envelope.kdf.p !== KDF_P) {
      throw new BackupError("BACKUP_UNSUPPORTED", "备份使用了不支持的密钥派生参数", 409);
    }
    let plaintext: Buffer;
    try {
      const key = deriveKey(passphrase, Buffer.from(envelope.kdf.salt, "base64url"), envelope.kdf);
      const decipher = createDecipheriv(CIPHER, key, Buffer.from(envelope.iv, "base64url"));
      decipher.setAAD(Buffer.from(JSON.stringify(envelopeHeader(envelope)), "utf8"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.payload, "base64url")),
        decipher.final()
      ]);
    } catch {
      throw new BackupError("BACKUP_DECRYPT_FAILED", "口令不正确，或备份文件已经损坏", 401);
    }
    let payload: BackupPayload;
    try {
      payload = JSON.parse(plaintext.toString("utf8")) as BackupPayload;
    } catch {
      throw new BackupError("BACKUP_INVALID", "备份内容不是有效的 Hearth 数据", 400);
    }
    if (payload.format !== "hearth-backup-payload" || payload.version !== BACKUP_VERSION) {
      throw new BackupError("BACKUP_UNSUPPORTED", "备份内容版本不受支持", 409);
    }
    return payload;
  }

  private replaceDatabase(candidate: HearthStore, preserved: Record<string, string>): void {
    const live = this.service.store.db;
    const sourceTables = listTables(candidate.db);
    const liveTables = new Set(listTables(live));
    for (const table of sourceTables) {
      if (LOCAL_ONLY_TABLES.has(table) || table === "app_meta") continue;
      if (!liveTables.has(table)) throw new Error(`当前数据库缺少表 ${table}`);
      assertSameColumns(candidate.db, live, table);
    }
    assertSameColumns(candidate.db, live, "app_meta");

    live.exec("BEGIN IMMEDIATE");
    try {
      for (const table of LOCAL_ONLY_TABLES) {
        if (!PRESERVED_LOCAL_TABLES.has(table) && liveTables.has(table)) {
          live.prepare(`DELETE FROM ${quoteIdentifier(table)}`).run();
        }
      }
      for (const table of sourceTables) {
        if (LOCAL_ONLY_TABLES.has(table) || table === "app_meta") continue;
        copyTable(candidate.db, live, table);
      }
      live.prepare("DELETE FROM app_meta").run();
      copyTable(candidate.db, live, "app_meta");
      for (const [key, value] of Object.entries(preserved)) {
        live.prepare(
          "INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
        ).run(key, value, this.clock().toISOString());
      }
      live.prepare(
        "INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
      ).run("schemaVersion", String(CURRENT_SCHEMA_VERSION), this.clock().toISOString());
      live.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
      live.exec("COMMIT");
    } catch (error) {
      live.exec("ROLLBACK");
      throw error;
    }
  }

  private restoreMasterKey(encoded: string | null): boolean {
    if (!encoded) return false;
    const key = Buffer.from(encoded, "base64");
    if (key.byteLength !== KEY_BYTES) return false;
    mkdirSync(dirname(this.masterKeyPath), { recursive: true });
    writeFileAtomic(this.masterKeyPath, key, 0o600);
    return true;
  }

  private preservedMeta(): Record<string, string> {
    const meta: Record<string, string> = {};
    for (const key of PRESERVED_META_KEYS) {
      const value = this.service.store.getMeta(key);
      if (value !== null) meta[key] = value;
    }
    return meta;
  }

  private readAppMeta(): Record<string, string> {
    const rows = this.service.store.db.prepare("SELECT key, value FROM app_meta ORDER BY key").all() as Array<{
      key: string;
      value: string;
    }>;
    return Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
  }

  private readMasterKey(): string | null {
    if (!existsSync(this.masterKeyPath)) return null;
    const key = readFileSync(this.masterKeyPath);
    return key.byteLength === KEY_BYTES ? key.toString("base64") : null;
  }

  private databaseCounts(store: HearthStore): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const table of ["tasks", "runs", "events", "approvals", "artifacts", "memories", "method_candidates", "method_applications", "devices"]) {
      const row = store.db.prepare(`SELECT COUNT(*) AS total FROM ${quoteIdentifier(table)}`).get() as { total?: number };
      counts[table] = Number(row.total ?? 0);
    }
    return counts;
  }

  private validatePassphrase(passphrase: string): void {
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      throw new BackupError(
        "PASSPHRASE_TOO_SHORT",
        `备份口令至少需要 ${MIN_PASSPHRASE_LENGTH} 个字符`,
        400
      );
    }
  }
}

function seal(plaintext: string, passphrase: string, createdAt: string): BackupEnvelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kdf = { name: KDF_NAME, salt: salt.toString("base64url"), N: KDF_N, r: KDF_R, p: KDF_P, keyBytes: KEY_BYTES } as const;
  const base = { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt, cipher: CIPHER, kdf, iv: iv.toString("base64url") } as const;
  const key = deriveKey(passphrase, salt, kdf);
  const cipher = createCipheriv(CIPHER, key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(envelopeHeader(base)), "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ...base, tag: cipher.getAuthTag().toString("base64url"), payload: encrypted.toString("base64url") };
}

function envelopeHeader(envelope: Pick<BackupEnvelope, "format" | "version" | "createdAt" | "cipher" | "kdf" | "iv">) {
  return {
    format: envelope.format,
    version: envelope.version,
    createdAt: envelope.createdAt,
    cipher: envelope.cipher,
    kdf: envelope.kdf,
    iv: envelope.iv
  };
}

function deriveKey(
  passphrase: string,
  salt: Buffer,
  kdf: { N: number; r: number; p: number; keyBytes: number }
): Buffer {
  return scryptSync(passphrase, salt, kdf.keyBytes, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 64 * 1024 * 1024
  });
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function writeFileAtomic(path: string, bytes: Buffer, mode?: number): void {
  const temporary = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, mode === undefined ? undefined : { mode });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function assertIntegrity(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
  if (row.integrity_check !== "ok") throw new Error("SQLite 完整性检查失败");
}

function listTables(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>).map((row) => String(row.name));
}

function assertSameColumns(source: DatabaseSync, target: DatabaseSync, table: string): void {
  const sourceColumns = tableColumns(source, table);
  const targetColumns = tableColumns(target, table);
  if (sourceColumns.join(",") !== targetColumns.join(",")) {
    throw new Error(`表 ${table} 的结构与当前应用不兼容`);
  }
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>)
    .map((row) => String(row.name));
}

function copyTable(source: DatabaseSync, target: DatabaseSync, table: string): void {
  const columns = tableColumns(source, table);
  const columnList = columns.map(quoteIdentifier).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const rows = source.prepare(`SELECT ${columnList} FROM ${quoteIdentifier(table)}`).all() as Array<Record<string, unknown>>;
  target.prepare(`DELETE FROM ${quoteIdentifier(table)}`).run();
  if (rows.length === 0) return;
  const insert = target.prepare(`INSERT INTO ${quoteIdentifier(table)} (${columnList}) VALUES (${placeholders})`);
  for (const row of rows) insert.run(...columns.map((column) => row[column] as never));
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

