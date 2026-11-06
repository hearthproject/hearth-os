import { describe, expect, it } from "vitest";
import { describeItem } from "./executor.ts";

describe("describeItem", () => {
  it("turns test commands into a high-level check step", () => {
    const item = { id: "1", type: "command_execution" as const, command: "npm test", aggregated_output: "", status: "completed" as const };
    expect(describeItem(item)).toBe("运行检查");
  });

  it("lists changed files", () => {
    const item = { id: "2", type: "file_change" as const, changes: [{ path: "result.md", kind: "update" as const }], status: "completed" as const };
    expect(describeItem(item)).toBe("修改文件：result.md");
  });

  it("does not expose raw terminal commands", () => {
    const item = { id: "3", type: "command_execution" as const, command: "x".repeat(200), aggregated_output: "", status: "completed" as const };
    expect(describeItem(item)).toBe("执行操作");
  });

  it("summarizes file reads without the pwsh wrapper", () => {
    const item = { id: "4", type: "command_execution" as const, command: "\"C:\\pwsh.exe\" -Command \"Get-Content a.txt\"", aggregated_output: "", status: "completed" as const };
    expect(describeItem(item)).toBe("查看项目文件");
  });

  it("summarizes directory listings without the cmd wrapper", () => {
    const item = { id: "5", type: "command_execution" as const, command: "\"C:\\Windows\\System32\\cmd.exe\" /c \"dir /a\"", aggregated_output: "", status: "completed" as const };
    expect(describeItem(item)).toBe("查看项目文件");
  });

  it("drops model metadata warnings", () => {
    const item = { id: "6", type: "error" as const, message: "Model metadata for `gpt-5.1-codex` not found. Defaulting to fallback metadata; this may impact performance." };
    expect(describeItem(item)).toBe("");
  });
});
