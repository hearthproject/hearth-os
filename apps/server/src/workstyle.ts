import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface WorkstyleProfile {
  content: string;
  updatedAt: string;
  isDefault: boolean;
}

export const DEFAULT_WORKSTYLE = `# 我的工作方式

## 沟通
- 先给结论，再给证据和风险。
- 不写空话，不夸张，不用“赋能、闭环、抓手”这类词。

## 提交
- 一个闭环一个 commit，提交信息用英文。
- 不主动建分支，不主动 push。

## 验证
- 改完先跑最相关的测试，再跑全量。
- 没跑过的检查要明确写“未验证”，不能声称通过。

## 不要动的目录
- 不要改 node_modules、dist、.git 和密钥文件。

## 工具偏好
- 优先使用仓库已有脚本和测试命令，不额外引入工具。
`;

export class WorkstyleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkstyleError";
    this.code = code;
  }
}

export class WorkstyleStore {
  private readonly path: string;
  private readonly maxChars: number;

  constructor(path: string, options: { maxChars?: number } = {}) {
    this.path = path;
    this.maxChars = options.maxChars ?? 20_000;
  }

  read(): WorkstyleProfile {
    if (!existsSync(this.path)) {
      return { content: DEFAULT_WORKSTYLE, updatedAt: new Date(0).toISOString(), isDefault: true };
    }
    try {
      return {
        content: readFileSync(this.path, "utf8"),
        updatedAt: new Date(statSync(this.path).mtimeMs).toISOString(),
        isDefault: false
      };
    } catch {
      return { content: DEFAULT_WORKSTYLE, updatedAt: new Date(0).toISOString(), isDefault: true };
    }
  }

  write(content: string): WorkstyleProfile {
    const clean = content.replace(/\r\n/g, "\n").trim();
    if (!clean) throw new WorkstyleError("WORKSTYLE_EMPTY", "工作方式不能为空；可以恢复默认内容。");
    if (clean.length > this.maxChars) {
      throw new WorkstyleError("WORKSTYLE_TOO_LONG", `工作方式最多 ${this.maxChars} 个字符。`);
    }
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${clean}\n`, "utf8");
    return { content: clean, updatedAt: new Date().toISOString(), isDefault: false };
  }

  reset(): WorkstyleProfile {
    return this.write(DEFAULT_WORKSTYLE);
  }
}

export function workstylePromptBlock(profile: WorkstyleProfile, maxChars = 2_000): string | null {
  const content = profile.content.trim();
  if (!content) return null;
  return `## Work style\n${content.length <= maxChars ? content : `${content.slice(0, maxChars)}…`}`;
}
