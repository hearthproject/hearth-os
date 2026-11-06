import type { HealthResponse, RunManifest, RunRecord } from "../../lib/types.ts";
import { formatTime } from "../../lib/format.ts";
import { AUTH_SOURCE_LABELS } from "../../lib/labels.ts";
import { EmptyLine } from "./ProSection.tsx";

export function ExecutorDetail({
  run,
  manifest,
  codex
}: {
  run: RunRecord | undefined;
  manifest: RunManifest | null;
  codex: HealthResponse["codex"] | undefined;
}) {
  return (
    <div className="executor-detail">
      <dl className="kv-grid">
        <div><dt>Provider</dt><dd>{codex?.providerName ?? "未读取"}</dd></div>
        <div><dt>模型</dt><dd>{codex?.model ?? "默认模型"}</dd></div>
        <div><dt>认证来源</dt><dd>{codex ? AUTH_SOURCE_LABELS[codex.authSource] ?? codex.authSource : "未读取"}</dd></div>
        <div><dt>清单标注</dt><dd>{manifest?.codex.profileLabel ?? "未读取运行清单"}</dd></div>
        <div><dt>执行线程</dt><dd className="mono select-all">{run?.threadId ?? "未记录"}</dd></div>
        <div><dt>工作区</dt><dd className="mono select-all">{run?.workspace ?? "未记录"}</dd></div>
        <div><dt>清单生成</dt><dd className="mono">{manifest ? formatTime(manifest.generatedAt) : "—"}</dd></div>
      </dl>

      {manifest && manifest.inputs.length > 0 && (
        <table className="data-table">
          <caption className="table-caption">输入证据</caption>
          <thead>
            <tr>
              <th scope="col">输入</th>
              <th scope="col">类型</th>
              <th scope="col">来源</th>
              <th scope="col">SHA-256</th>
              <th scope="col">抓取结果</th>
            </tr>
          </thead>
          <tbody>
            {manifest.inputs.map((input, index) => (
              <tr key={`${input.label}-${index}`}>
                <td>{input.label}</td>
                <td>{input.kind}</td>
                <td className="mono truncate" title={input.source}>{input.source}</td>
                <td className="mono select-all tiny" title={input.sha256}>{input.sha256 ? `${input.sha256.slice(0, 16)}…` : "未记录"}</td>
                <td className="truncate">{metadataSummary(input.metadata)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!manifest && <EmptyLine text="读取运行清单后才能核对输入摘要与执行线程。" />}
    </div>
  );
}

function metadataSummary(metadata: unknown): string {
  if (metadata === null || typeof metadata !== "object") return "—";
  const record = metadata as Record<string, unknown>;
  if (record.ok === false) return `抓取失败：${String(record.errorCode ?? "未知")} ${String(record.errorMessage ?? "")}`.trim();
  const status = typeof record.httpStatus === "number" ? `HTTP ${record.httpStatus}` : null;
  const finalUrl = typeof record.finalUrl === "string" ? record.finalUrl : null;
  const branch = typeof record.branch === "string" ? `分支 ${record.branch}` : null;
  const head = typeof record.headSha === "string" ? `head ${String(record.headSha).slice(0, 8)}` : null;
  return [status, branch, head, finalUrl].filter(Boolean).join(" · ") || "无附加证据";
}
