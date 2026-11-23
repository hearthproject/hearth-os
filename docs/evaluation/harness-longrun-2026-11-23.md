# Long-run harness acceptance matrix (2026-11-23)

Offline matrix using the deterministic fake model. No API key, network or real provider is used.

- Cases: **18/18 passed**
- Max estimated context peak: **623 tokens**
- Simulated recoveries: **3**
- Compactions observed: **10**

| Case | Result | Duration | Notes |
|---|---|---|---|
| 500 turns | PASS | 923ms | tokenPeak: 623; checkpoints: 1244 |
| two restarts | PASS | 16ms | recoveries: 2; tokenPeak: 316 |
| checkpoint disk failure | PASS | 4ms | failures: 1 |
| 429 and 5xx retry | PASS | 122ms | retries: 5; recoveries: 1 |
| length continuation | PASS | 5ms | retries: 3; failures: 1 |
| 20MB tool output | PASS | 49ms | artifactBytes: 20971520 |
| 100 tools | PASS | 10ms | exposed: 1; matched: 3 |
| goal 20 turns | PASS | 38ms | turns: 20; tokenPeak: 523 |
| goal verifier | PASS | 8ms | rejected: 1 |
| subagent stall and resume | PASS | 6ms | stalls: 1; resumes: 1 |
| active work finish gate | PASS | 5ms | gated: 1 |
| 20 compactions | PASS | 47ms | compactions: 10 |
| crash: after-prepare | PASS | 44ms | crashPoint: after-prepare; executions: 3 |
| crash: after-dispatch | PASS | 21ms | crashPoint: after-dispatch; executions: 0 |
| crash: mid-tool | PASS | 32ms | crashPoint: mid-tool; executions: 3 |
| crash: after-settle | PASS | 25ms | crashPoint: after-settle; executions: 3 |
| crash: after-checkpoint | PASS | 31ms | crashPoint: after-checkpoint; executions: 3 |
| crash: after-cleanup | PASS | 30ms | crashPoint: after-cleanup; executions: 0 |

## Environment

- Runtime: `packages/agent-runtime` with the deterministic fake model.
- Command: `npm run test:longrun`.
- Scope: checkpoint survival, restarts, provider errors, truncation, large output, tool catalog, goals, verifier, subagent stalls and active-work finish gate.
