# Long-run harness acceptance matrix (2026-11-20)

Offline matrix using the deterministic fake model. No API key, network or real provider is used.

- Cases: **12/12 passed**
- Max estimated context peak: **599 tokens**
- Simulated recoveries: **3**
- Compactions observed: **10**

| Case | Result | Duration | Notes |
|---|---|---|---|
| 500 turns | PASS | 1196ms | tokenPeak: 599; checkpoints: 1244 |
| two restarts | PASS | 17ms | recoveries: 2; tokenPeak: 307 |
| checkpoint disk failure | PASS | 4ms | failures: 1 |
| 429 and 5xx retry | PASS | 54ms | retries: 5; recoveries: 1 |
| length continuation | PASS | 5ms | retries: 3; failures: 1 |
| 20MB tool output | PASS | 52ms | artifactBytes: 20971520 |
| 100 tools | PASS | 13ms | exposed: 1; matched: 3 |
| goal 20 turns | PASS | 49ms | turns: 20; tokenPeak: 499 |
| goal verifier | PASS | 8ms | rejected: 1 |
| subagent stall and resume | PASS | 8ms | stalls: 1; resumes: 1 |
| active work finish gate | PASS | 7ms | gated: 1 |
| 20 compactions | PASS | 60ms | compactions: 10 |

## Environment

- Runtime: `packages/agent-runtime` with the deterministic fake model.
- Command: `npm run test:longrun`.
- Scope: checkpoint survival, restarts, provider errors, truncation, large output, tool catalog, goals, verifier, subagent stalls and active-work finish gate.
