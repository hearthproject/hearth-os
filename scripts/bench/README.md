# Harness benchmarks

These scripts measure the harness, not the model. They build throwaway repositories, call the same tools the native executor uses, and write a JSON report.

## ACI suite

```bash
npm run bench:aci          # new harness -> eval/aci/post-change.json
npm run bench:legacy       # run the legacy script in a pre-change worktree
```

`legacy-aci.ts` is intentionally compatible with the old tool surface so it can run in a worktree checked out at `c6fbf41`:

```bash
git worktree add /tmp/hearth-baseline c6fbf41 --detach
# link node_modules, then copy the script into the worktree
npx tsx scripts/bench/legacy-aci.ts pre-change.json
```

## Headless agent runner

`run-agent.ts` drives `runAgent` with the coding profile and an OpenAI-compatible model.

```bash
npm run agent:run -- \
  --workspace /path/to/repo \
  --goal "Fix the failing test" \
  --out /tmp/hearth-run \
  --base-url https://api.example.com/v1 \
  --model example-model
```

Environment fallbacks: `HEARTH_MODEL_API_KEY` or `OPENAI_API_KEY`, `OPENAI_BASE_URL`.

## Public benchmark adapters

The internal suite is the fast, deterministic gate. Public benchmarks are run through `hearth-eval` or the upstream harnesses:

- Aider Polyglot: 225 exercises, six languages; report pass@2 and format errors separately.
- SWE-bench Verified: 500 Python issues; use Docker and apply the agent's patch.
- Terminal-Bench 2.x: 89 terminal tasks through Harbor.

Do not mix harness scores with model scores in one table. Record the model, commit, budget and context window with every run.

### Generic suite runner

`run-suite.ts` runs one agent per JSONL task in a disposable copy, executes an optional test command and records the diff. Convert the upstream dataset to this shape:

```json
{"id":"task-1","workspace":"/data/task-1","prompt":"Fix the failing test","testCommand":"pytest -q","testTimeoutSeconds":600}
```

```bash
npm run bench:suite -- \
  --suite tasks.jsonl --report aider.json \
  --model example-model --base-url https://api.example.com/v1 --api-key "$HEARTH_MODEL_API_KEY"
```

For Aider, map each exercise directory and run its test script. For SWE-bench, use the checked-out issue workspace and the repository's test command. For Terminal-Bench, point `workspace` at the task container's mounted directory and use the task's verification command. Keep Docker/container orchestration outside the harness so the same agent runner is measured.
