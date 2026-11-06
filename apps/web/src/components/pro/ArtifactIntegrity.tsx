import type { ArtifactRecord, RunManifest } from "../../lib/types.ts";
import { formatBytes, formatTime } from "../../lib/format.ts";
import { EmptyLine } from "./ProSection.tsx";

export function ArtifactIntegrity({ artifacts, manifest }: { artifacts: ArtifactRecord[]; manifest: RunManifest | null }) {
  if (artifacts.length === 0) return <EmptyLine text="还没有产物文件。" />;
  const declared = new Map((manifest?.artifacts ?? []).map((entry) => [entry.path, entry]));

  return (
    <div className="artifact-integrity">
      <p className="integrity-summary">
        {manifest
          ? `本机产物 ${artifacts.length - 1} 个 · 运行清单声明 ${declared.size} 个 · 已保存运行清单`
          : `本机产物 ${artifacts.length} 个 · 运行清单未读取`}
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">文件</th>
            <th scope="col" className="align-num">大小</th>
            <th scope="col">SHA-256</th>
            <th scope="col">与清单</th>
            <th scope="col">保存时间</th>
          </tr>
        </thead>
        <tbody>
          {artifacts.map((artifact) => {
            const entry = declared.get(artifact.relativePath);
            const verdict = artifact.relativePath === "run-manifest.json"
              ? "运行清单"
              : !manifest
                ? "未核对"
                : !entry
                  ? "未在清单"
                  : entry.sha256 === artifact.sha256
                    ? "一致"
                    : "不一致";
            return (
              <tr key={artifact.id} className={verdict === "不一致" ? "row-risk" : undefined}>
                <td className="mono truncate" title={artifact.relativePath}>{artifact.relativePath}</td>
                <td className="align-num">{formatBytes(artifact.bytes)}</td>
                <td className="mono select-all tiny" title={artifact.sha256}>{artifact.sha256}</td>
                <td>{verdict}</td>
                <td className="mono">{formatTime(artifact.createdAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
