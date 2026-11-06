import { describe, expect, it } from "vitest";
import { describeItem } from "./executor.ts";

describe("describeItem", () => {
  it("shows the real command line", () => {
    const item = { id: "1", type: "command_execution" as const, command: "npm test", aggregated_output: "", status: "completed" as const };
    expect(describeItem(item)).toBe("执行命令：npm test");
  });

  it("lists changed files", () => {
    const item = { id: "2", type: "file_change" as const, changes: [{ path: "result.md", kind: "update" as const }], status: "completed" as const };
    expect(describeItem(item)).toBe("修改文件：result.md");
  });

  it("truncates long commands", () => {
    const item = { id: "3", type: "command_execution" as const, command: "x".repeat(200), aggregated_output: "", status: "completed" as const };
    expect(describeItem(item).endsWith("…")).toBe(true);
    expect(describeItem(item).length).toBeLessThanOrEqual(166);
  });

  it("strips the pwsh runtime wrapper", () => {
    const item = { id: "4", type: "command_execution" as const, command: "\"C:\\pwsh.exe\" -Command \"Get-Content a.txt\"", aggregated_output: "", status: "completed" as const };
    expect(describeItem(item)).toBe("执行命令：Get-Content a.txt");
  });

  it("strips the cmd runtime wrapper", () => {
    const item = { id: "5", type: "command_execution" as const, command: "\"C:\\Windows\\System32\\cmd.exe\" /c \"dir /a\"", aggregated_output: "", status: "completed" as const };
    expect(describeItem(item)).toBe("执行命令：dir /a");
  });
});
