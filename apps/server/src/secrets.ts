import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";

export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("Master key must be 32 bytes");
    this.key = key;
  }

  static fromKeyFile(path: string): SecretBox {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });
    }
    return new SecretBox(readFileSync(path));
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
  }

  decrypt(value: string): string {
    const [version, ivValue, tagValue, dataValue] = value.split(":");
    if (version !== VERSION || !ivValue || !tagValue || !dataValue) throw new Error("Invalid secret envelope");
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataValue, "base64url")), decipher.final()]).toString("utf8");
  }
}
