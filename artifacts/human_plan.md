# Hearth Native Harness Sandbox — Engineering Plan

Status: approved plan v2, P0 implementation in progress on `main`.
Audience: Hearth server/runtime engineers.

## 1. Approved requirements

1. Add a native sandbox layer that runs independently of tool approvals.
2. Keep `approvalMode=full` as the only product default; do not add `sandbox_permissions`, `justification`, allow-once, or an approval-based sandbox upgrade path.
3. Put a `SandboxPolicy` / `SandboxProvider` / `ConfinedCommand` contract in `@hearth/agent-runtime`; the shell layer passes exact argv, cwd, policy, env, session id, and an abort signal.
4. P0 mode set: `read-only`, `workspace-write`, `danger-full-access`. Only operator/task configuration may select `danger-full-access`; model tool arguments cannot.
5. P0 enforcement is file write/delete only on Windows. Mark it `partial`; do not claim read, network, or process-visibility isolation.
6. Confine all native child-process entry points: `shell`, `run_tests`, `diagnostics`, foreground shell, background shell, and `shell_wait` sessions.
7. Enforce fail-closed behavior: if a provider is required and unavailable, do not spawn; surface `SANDBOX_UNAVAILABLE`.
8. Replace inherited `process.env` with an allowlist; remove API keys, tokens, secrets, passwords, `HEARTH_*`, loader variables, and package-manager credential variables. Point `TMP`/`TEMP` at a private temp directory and package caches at the workspace cache.
9. Use the DeepSeek Harness Windows ACL runner as a thin provider dependency; do not copy Win32 FFI code and do not make Cordis a host-lifecycle dependency.
10. Probe the runner once before the model loop; cache success/failure. A missing runner, a probe failure, or a `windows-acl-run:` failure is a sandbox failure, not a normal command failure.
11. Resolve the sandbox root from the task worktree/project root and `outDir` common ancestor, constrained to `HEARTH_ROOT`; do not expose writable roots outside the sandbox root to the shell.
12. Record sandbox selection, downgrade, and unavailability in `<outDir>/.hearth/sandbox/audit.jsonl`; emit `sandbox.selected` / `sandbox.unavailable` progress events.
13. Show a compact sandbox badge in task detail (`工作区写`, `只读`, or `完全权限`) without adding approval UI.
14. Keep `approvalMode=full` capable of auto-approving a sensitive tool while the sandbox decision remains unchanged.
15. Deliver packaging support for the runner and its runtime dependency closure under `resources/sandbox/windows-acl`.
16. Work directly on `main`; do not create a feature branch. Commit titles/body are English and follow Why / What / Test.
17. This question mechanism applies to both ordinary conversation and plan mode.

## 2. Design

### 2.1 Layers

```
native-executor
  -> prepareNativeSandbox()
  -> resolveSandboxPolicy()
  -> AgentToolContext.sandbox
  -> shell-session.startShellSession()
  -> provider.confine(exact argv)
  -> WindowsAclSandboxProvider
  -> node runner.js --workspace <root> --temp <temp> --mode <mode> -- <argv...>
```

`apps/server/src/sandbox.ts` remains an authorization-decision service for delegation/completion. It is not the execution sandbox. `@hearth/agent-runtime` must not import server code.

### 2.2 Contracts

- `SandboxMode`: `read-only | workspace-write | danger-full-access`.
- `TaskPermissions.sandboxMode?`: task/project configuration only.
- `SandboxPolicy`: mode, canonical workspace root, writable roots, read roots, network hosts, private temp root, session id, filtered env.
- `SandboxRequest`: exact argv, cwd, policy, optional signal.
- `ConfinedCommand`: argv, cwd, env, backend, enforcement, network enforcement, denial signatures, runner failure rules.
- `SandboxProvider.confine()` is async and returns a fully resolved command; callers must not re-parse a command string.

### 2.3 Mode behavior

| Mode | P0 Windows behavior | Enforcement |
| --- | --- | --- |
| `read-only` | ACL denies write/delete; reads remain open | partial |
| `workspace-write` | ACL permits task workspace plus private temp; network remains open | partial |
| `danger-full-access` | no wrapper; explicit operator downgrade only | none |

### 2.4 Environment and paths

- Windows private temp base is `LOCALAPPDATA\Temp\hearth-sandbox\<taskId>`; it must be outside the workspace.
- Child env is built from an allowlist, then augmented with system PATH entries required by PowerShell and `cmd`.
- `npm_config_cache`, `YARN_CACHE_FOLDER`, `PIP_CACHE_DIR`, `CARGO_HOME`, and `GOMODCACHE` point inside `<workspace>/.hearth/sandbox/cache`.
- Shell command and output logs pass through the existing secret redaction function.

### 2.5 Failure and audit semantics

- No provider and no explicit `unsafeNoSandbox` → throw `SANDBOX_UNAVAILABLE`; no spawn.
- Provider probe failure → append `sandbox.unavailable` audit and fail before the model loop.
- Runner fatal signature or exit code `127` → `runner_failed`, not a normal command failure.
- ACL denial signatures include English and localized Windows text; preserve stderr for diagnosis.
- Sandbox selection audit includes task id, backend, mode, enforcement, workspace root, temp root, and policy warnings; never include secret values.

## 3. Testing

### 3.1 Automated

- `packages/agent-runtime/src/harness/sandbox.test.ts`
  - path escape rejection, outside writable-root warning, danger mode, env filtering, runner failure classification, temp placement.
- `apps/server/src/native-sandbox.test.ts` (Windows)
  - real runner probe;
  - write inside workspace succeeds;
  - write outside workspace fails and creates no file;
  - returned backend is `windows-acl`.
- `packages/agent-runtime/src/tools.test.ts` and `harness.test.ts`
  - missing provider does not spawn;
  - explicit `unsafeNoSandbox` keeps existing non-sandbox shell behavior;
  - background session kill regression uses the absolute `taskkill.exe` path.
- `apps/server/src/scheduler.test.ts`
  - full-permission sensitive shell call is auto-approved with zero pending approvals;
  - shell action binding finds the absolute Windows PowerShell path.
- Full gate: `npm run typecheck`; `npm test`.
- Packaging gate: `node scripts/build-server.mjs` stages the runner and dependency closure.

### 3.2 Manual Windows acceptance

1. In a normal (non-admin) Windows user, start a native coding task with `shell`.
2. Write inside the task workspace and confirm success.
3. Write/delete outside the workspace and confirm `Access is denied`/localized denial and no file mutation.
4. Confirm `TMP`/`TEMP` point into the private temp tree.
5. Confirm `OPENAI_API_KEY` and `HEARTH_*` are absent from the child environment.
6. Confirm task detail shows the sandbox badge and audit JSONL has `sandbox.selected`.
7. Confirm a packaged build can resolve `resources/sandbox/windows-acl/runner.js` and pass probe.

### 3.3 Current verification record

- `npm run typecheck`: passed.
- `npm test`: 124 test files, 895 tests, all passed.
- Windows ACL provider integration test: passed against the real runner.
- `node scripts/build-server.mjs`: completed; runner and dependency closure staged.
