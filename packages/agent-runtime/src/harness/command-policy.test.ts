import { describe, expect, it } from "vitest";
import { classifyShellCommand, shellScriptFromArgv } from "./command-policy.ts";

describe("shell command classifier", () => {
  it("allows read-only commands", () => {
    expect(classifyShellCommand("git status --short").kind).toBe("read-only");
    expect(classifyShellCommand("rg -n TODO src").kind).toBe("read-only");
    expect(classifyShellCommand("Get-Content README.md").kind).toBe("read-only");
  });

  it("treats build and write commands as mutating", () => {
    expect(classifyShellCommand("npm test").kind).toBe("mutating");
    expect(classifyShellCommand("git add -A").kind).toBe("mutating");
    expect(classifyShellCommand("New-Item -ItemType File out.txt").kind).toBe("mutating");
  });

  it("flags destructive commands", () => {
    expect(classifyShellCommand("rm -rf build").kind).toBe("destructive");
    expect(classifyShellCommand("Remove-Item -Recurse -Force C:\\tmp\\x").kind).toBe("destructive");
    expect(classifyShellCommand("git reset --hard HEAD").kind).toBe("destructive");
    expect(classifyShellCommand("git status && rm -rf build").kind).toBe("destructive");
  });

  it("does not silently allow unknown commands", () => {
    expect(classifyShellCommand("frobnicate --all").kind).toBe("unknown");
    expect(classifyShellCommand("custom-tool run").kind).toBe("unknown");
    expect(classifyShellCommand("echo $(rm -rf build)").kind).toBe("unknown");
  });

  it("extracts the script from shell argv", () => {
    expect(shellScriptFromArgv(["-NoProfile", "-NonInteractive", "-Command", "git status"], "powershell")).toBe("git status");
    expect(shellScriptFromArgv(["-c", "npm test"], "sh")).toBe("npm test");
    expect(shellScriptFromArgv(["--check"], "sh")).toBeNull();
  });
});
