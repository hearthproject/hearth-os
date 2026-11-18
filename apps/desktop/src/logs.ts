import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export function resolveDesktopLogDir(localAppData = process.env.LOCALAPPDATA): string {
  const base = localAppData && localAppData.trim()
    ? localAppData
    : join(process.env.USERPROFILE ?? ".", "AppData", "Local");
  return join(base, "Hearth", "logs");
}

export class RotatingLog {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly keep: number;

  constructor(path: string, maxBytes = 5 * 1024 * 1024, keep = 3) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.keep = keep;
    mkdirSync(dirname(path), { recursive: true });
  }

  write(line: string): void {
    const text = line.endsWith("\n") ? line : `${line}\n`;
    try {
      if (existsSync(this.path) && statSync(this.path).size + text.length > this.maxBytes) {
        this.rotate();
      }
      appendFileSync(this.path, text, "utf8");
    } catch {
      // Logging must never take down the desktop shell.
    }
  }

  private rotate(): void {
    for (let index = this.keep - 1; index >= 1; index -= 1) {
      const from = `${this.path}.${index}`;
      const to = `${this.path}.${index + 1}`;
      if (!existsSync(from)) continue;
      if (index === this.keep - 1 && existsSync(to)) unlinkSync(to);
      renameSync(from, to);
    }
    renameSync(this.path, `${this.path}.1`);
  }
}

export interface DesktopLogs {
  dir: string;
  main: RotatingLog;
  server: RotatingLog;
}

export function createDesktopLogs(dir = resolveDesktopLogDir()): DesktopLogs {
  return {
    dir,
    main: new RotatingLog(join(dir, "main.log")),
    server: new RotatingLog(join(dir, "server.log"))
  };
}
