# 复现 CI Bug：GoldMind PR #14 Backend (pytest)

## 结论

已在隔离工作区检出 PR #14 head，并按 CI 的等价命令运行后端完整测试。

- 结果：**复现失败，pytest 退出码 1**。
- 全量结果：**8 failed, 1199 passed, 13 warnings in 186.23s**。
- 聚焦结果：**8 failed, 14 passed, 5 warnings in 4.37s**，可独立复现同一批失败。
- 8 个失败都指向同一个兼容性问题：FastAPI `0.162.0` 把 `include_router()` 的结果保留为 `_IncludedRouter`，而仓库测试和 API 文档生成器仍直接遍历 `app.routes` 并假定其中是展开后的 `APIRoute`。
- 未修改仓库代码，也未访问真实外部服务或使用真实密钥。

## 输入与目标提交

| 项目 | 值 |
|---|---|
| 仓库 | `https://github.com/JasonBuildAI/GoldMind` |
| PR | `https://github.com/JasonBuildAI/GoldMind/pull/14` |
| PR title | `chore(deps): bump the pip group in /backend with 15 updates` |
| 目标 head | `1c5efe94dfa784c3b6c0b5c221286f489d7f11f2` |
| 本地检出 | detached HEAD，等于 `origin/pr-14`，提交 `1c5efe9` |
| CI run | `https://github.com/JasonBuildAI/GoldMind/actions/runs/40932407071` |
| 失败作业 | `Backend (pytest)`，`https://github.com/JasonBuildAI/GoldMind/actions/runs/40932407071/job/123653982992` |

工作树状态：`## HEAD (no branch)`，无文件差异。

## 运行环境

- 宿主：Windows 10 `10.0.26200`（本机 `platform.platform()` 输出为 `Windows-10-10.0.26200-SP0`）。
- 隔离目录：`D:\App\hearth-os\.hearth\workspaces\5bf7eb1b-bde2-4c31-9d71-572c571b68e5`。
- Python：`3.11.14`。
- 解释器：`.runtime\python\Scripts\python.exe`。
- 虚拟环境准备方式：上一轮已由工作区准备器执行 `uv venv --python 3.11`，随后从 `backend/requirements.txt` 与 `backend/requirements-dev.txt` 安装依赖；准备日志见 `.runtime/prepare.log`，运行时元数据见 `.runtime/runtime.json`。
- 关键版本：
  - `pytest 9.2.0`
  - `pytest-asyncio 1.4.1.post1`
  - `fastapi 0.162.0`
  - `pydantic 2.14.1`
  - `sqlalchemy 2.1.6`

说明：`backend/requirements-dev.txt` 写的是 `pytest>=9.1.1` 与 `pytest-asyncio>=1.4.1`，本地实际解析到上述新版本；PR 正文标注的 pytest 更新目标为 `9.1.1`。CI 当次实际解析出的精确依赖集合不在输入中，因此这一点不能逐包对比，但本失败可直接归因于精确固定的 `fastapi==0.162.0`。

## 实际执行的测试

CI 的真实口径来自 `.github/workflows/ci.yml`：

- 工作目录：`backend`
- 安装：`pip install -r requirements.txt -r requirements-dev.txt`
- 测试：`python -m pytest > pytest-output.txt 2>&1`

本地实际启动的 pytest 子进程命令为：

```text
D:\App\hearth-os\.hearth\workspaces\5bf7eb1b-bde2-4c31-9d71-572c571b68e5\.runtime\python\Scripts\python.exe -m pytest
```

工作目录：

```text
D:\App\hearth-os\.hearth\workspaces\5bf7eb1b-bde2-4c31-9d71-572c571b68e5\repo\backend
```

由于当前 PowerShell 核心模块不可用，使用 Python `subprocess.run(..., stdout=..., stderr=STDOUT)` 捕获输出，测试命令本身未改变。原始日志：

- `out/pytest-output.txt`：有效全量复现，退出码 1。
- `out/pytest-exit-code.txt`：内容为 `1`。
- `out/pytest-output-initial-temp-error.txt`：第一次因宿主临时目录权限失败的日志，见下文。
- `out/pytest-focused.txt`：只跑 8 个失败点的短日志。
- `out/pytest-focused-exit-code.txt`：内容为 `1`。
- `out/route-introspection.txt`：FastAPI 路由对象检查结果。

## 有效复现结果

全量日志尾部：

```text
FAILED tests/integration/test_ai_response_contract.py::test_ai_endpoints_declare_a_real_response_model[/api/gold/bearish-factors-ai]
FAILED tests/integration/test_ai_response_contract.py::test_ai_endpoints_declare_a_real_response_model[/api/gold/bullish-factors-ai]
FAILED tests/integration/test_ai_response_contract.py::test_ai_endpoints_declare_a_real_response_model[/api/gold/institution-predictions-ai]
FAILED tests/integration/test_ai_response_contract.py::test_ai_endpoints_declare_a_real_response_model[/api/gold/investment-advice-ai]
FAILED tests/integration/test_ai_response_contract.py::test_ai_endpoints_declare_a_real_response_model[/api/gold/market-summary-ai]
FAILED tests/integration/test_all_endpoints.py::test_sweep_discovered_endpoints
FAILED tests/integration/test_api_doc.py::test_api_doc_matches_route_table
FAILED tests/integration/test_api_doc.py::test_doc_flags_the_llm_backed_endpoints
8 failed, 1199 passed, 13 warnings in 186.23s (0:03:06)
```

代表错误：

```text
E       AssertionError: 找不到路由 /api/gold/bearish-factors-ai
E       AssertionError: 只发现 2 个 GET 接口
E       AssertionError: API.md（zh）与路由表不一致。修复：cd backend && python scripts/gen_api_doc.py
E       AssertionError: assert '会调用 LLM' in '# GoldMind API ...'
```

聚焦命令：

```text
python -m pytest tests/integration/test_ai_response_contract.py tests/integration/test_all_endpoints.py::test_sweep_discovered_endpoints tests/integration/test_api_doc.py
```

聚焦结果：

```text
8 failed, 14 passed, 5 warnings in 4.37s
```

## 根因

`backend/requirements.txt` 将 FastAPI 从 `0.115.0` 升到 `0.162.0`；`backend/app/main.py:257-262` 仍使用 `app.include_router(...)`。在本机 FastAPI `0.162.0` 下，`app.routes` 不再立即包含这 6 个路由的子级 `APIRoute`，而是包含 6 个 `_IncludedRouter` 惰性包装对象。

`out/route-introspection.txt` 的实际结果：

```text
fastapi=0.162.0
app.routes=12
...
_IncludedRouter|None|None
_IncludedRouter|None|None
_IncludedRouter|None|None
_IncludedRouter|None|None
_IncludedRouter|None|None
_IncludedRouter|None|None
APIRoute|'/'|{'GET'}
APIRoute|'/health'|{'GET'}
analysis.router.routes=14
APIRoute|'/factors'|{'GET'}
APIRoute|'/bullish-factors-ai' ... （完整内容见输出文件）
```

实际路由仍能响应请求，因此大量接口测试通过；失效的是依赖 `app.routes` 的静态枚举：

- `backend/tests/integration/test_ai_response_contract.py:82` 用 `isinstance(r, APIRoute)` 查找 AI 路由，找不到 5 个 GET 路由。
- `backend/tests/integration/test_all_endpoints.py:24` 只用 `app.routes` 收集 GET 路径，所以只得到 `/` 与 `/health`；第 45 行因此报 `只发现 2 个 GET 接口`。
- `backend/scripts/gen_api_doc.py:41` 同样只遍历 `app.routes`，生成的文档只含根路径与健康检查，导致文档与已提交的完整 API 文档不一致，并且不再包含“会调用 LLM”的 AI 刷新接口说明。

这不是测试访问了真实服务、数据库或网络导致的失败；是依赖升级暴露出的路由表枚举契约变化。可能修复方向是改用 FastAPI/Starlette 提供的展开后路由视图（例如递归解析 `_IncludedRouter` 的有效路由，或从 OpenAPI schema 派生），或将 FastAPI 固定回兼容版本。本次按要求没有修改代码。

## 首次运行的环境偏差

第一次全量运行时，`TEMP`、`TMP` 均为宿主目录 `D:\Temp`，该目录对当前进程不可写：

```text
E   PermissionError: [WinError 5] ...: 'D:\\Temp\\pytest-of-Jason'
7 warnings, 1207 errors in 69.14s (0:01:09)
```

这不是 PR 的 CI 失败：CI 使用 Ubuntu runner 的可写临时目录。将 `TEMP`、`TMP`、`TMPDIR`、`PYTEST_DEBUG_TEMPROOT` 指向工作区内可写的 `.runtime\pytest-tmp` 后，测试正常执行并得到上面的 8 个真实失败。第一次日志保留在 `out/pytest-output-initial-temp-error.txt`，未把它计入有效复现结论。

## 与 CI 的一致性

可以确认一致的部分：

- 同一个 PR head `1c5efe9`。
- 同为 Python 3.11。
- 同为 `backend` 工作目录和 `python -m pytest` 命令。
- `fastapi==0.162.0` 是 PR 精确固定的版本，且本地失败与该版本的路由表行为直接对应。
- 输入明确记录 CI 的 `Backend (pytest)` 为 `FAILURE`；本地结果为退出码 1。

不能确认的部分：

- 输入中没有 CI job 的原始 `pytest-output.txt`，无法逐条核对 CI 的失败测试名、traceback 和精确依赖解析结果。
- 因此本报告能确认“后端 pytest 在本地同样失败”，但不能把 CI 的失败集合逐测试证明为完全相同。
- 本地 `pytest 9.2.0` 与 PR 正文的 `9.1.1` 目标存在版本号差异；这不改变由 FastAPI 路由枚举导致的失败机制，但精确 CI 环境仍需 CI 日志确认。

## 最小复现步骤

1. 检出 `1c5efe9`。
2. 使用 Python 3.11 安装 `backend/requirements.txt` 与 `backend/requirements-dev.txt`。
3. 在 Windows 上，将 `TEMP`、`TMP`、`TMPDIR`、`PYTEST_DEBUG_TEMPROOT` 指向可写目录。
4. 进入 `repo/backend`。
5. 运行：

   ```text
   python -m pytest
   ```

   预期退出码 1，得到 8 failed / 1199 passed。

6. 可选的最小聚焦复现：

   ```text
   python -m pytest tests/integration/test_ai_response_contract.py tests/integration/test_all_endpoints.py::test_sweep_discovered_endpoints tests/integration/test_api_doc.py
   ```

   预期退出码 1，得到 8 failed / 14 passed。

## 产物与限制

- 已记录环境、命令、完整日志、聚焦日志、退出码和路由对象检查。
- 未修改任何代码，未联网，未推送分支，未创建 PR，未发布评论，未使用真实密钥。
- 当前未知项：CI 原始 pytest 日志、CI 精确安装版本清单，以及 CI 是否也恰好失败在这 8 个测试上；这些需要 `Backend (pytest)` job 的完整日志才能最终确认。