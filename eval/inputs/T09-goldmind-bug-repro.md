# T09 输入：GoldMind PR #14 后端测试失败复现

- 仓库：`https://github.com/JasonBuildAI/GoldMind`
- PR：`https://github.com/JasonBuildAI/GoldMind/pull/14`
- 评审时 head commit：`1c5efe94dfa784c3b6c0b5c221286f489d7f11f2`
- 失败检查：Backend (pytest)
- CI 运行：`https://github.com/JasonBuildAI/GoldMind/actions/runs/40932407071`
- 输出报告：`eval/runs/T09/bug-reproduction.md`

## 要求

- 在独立工作区检出 PR head，记录 Python 版本、安装方式和实际执行的测试命令。
- 复现 Backend 失败，至少给出失败测试名、错误输出、实际结果与 CI 是否一致。
- 如果本地无法复现，说明环境差异、尝试过的命令和下一步需要的证据。
- 给出最小复现步骤和可能根因，但不要修改代码或提交修复。
- 不访问真实外部服务，不使用真实密钥，不修改共享环境。

