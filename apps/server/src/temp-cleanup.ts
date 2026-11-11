import { rmSync } from "node:fs";

export function removeTempDirectory(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // A provider process can still hold the directory on Windows; cleanup is best effort.
  }
}
