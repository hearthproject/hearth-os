import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ArtifactPreview } from "../components/ArtifactPreview.tsx";
import { api } from "../lib/api.ts";
import { abbreviateHash, formatBytes, relativeTime } from "../lib/format.ts";
import type { ArtifactListItem } from "../lib/types.ts";
import { useViewMode } from "../lib/view-mode.tsx";

export function ArtifactsPage() {
  const [selected, setSelected] = useState<ArtifactListItem | null>(null);
  const { mode } = useViewMode();
  const pro = mode === "pro";
  const artifactsQuery = useQuery({ queryKey: ["artifacts"], queryFn: api.artifacts, refetchInterval: 8_000 });
  const artifacts = artifactsQuery.data?.artifacts ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <h1>产物</h1>
        <span className="page-meta">每个产物都有来源和校验值。</span>
      </div>

      {artifactsQuery.isLoading ? (
        <p className="section-empty">正在读取产物…</p>
      ) : artifacts.length === 0 ? (
        <section className="panel">
          <p className="section-empty">还没有产物。任务完成后，文件会按任务归档到这里。</p>
        </section>
      ) : (
        <section className="panel table-panel">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">文件</th>
                <th scope="col">任务</th>
                <th scope="col" className="align-num">大小</th>
                <th scope="col">保存时间</th>
                {pro && <th scope="col">SHA-256</th>}
                {pro && <th scope="col">路径</th>}
              </tr>
            </thead>
            <tbody>
              {artifacts.map((artifact) => (
                <tr key={artifact.id}>
                  <td><button className="link-button" onClick={() => setSelected(artifact)}>{artifact.relativePath.split("/").pop()}</button></td>
                  <td className="truncate">{artifact.taskTitle}</td>
                  <td className="align-num">{formatBytes(artifact.bytes)}</td>
                  <td>{relativeTime(artifact.createdAt)}</td>
                  {pro && <td className="mono select-all tiny" title={artifact.sha256}>{abbreviateHash(artifact.sha256, 16, 8)}</td>}
                  {pro && <td className="mono truncate" title={artifact.relativePath}>{artifact.relativePath}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {selected && <ArtifactPreview artifact={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
