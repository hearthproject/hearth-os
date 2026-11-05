import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { FileJson, FileText, Image as ImageIcon, Package } from "lucide-react";
import { ArtifactPreview } from "../components/ArtifactPreview.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { api } from "../lib/api.ts";
import { formatBytes, relativeTime } from "../lib/format.ts";
import type { ArtifactListItem } from "../lib/types.ts";

export function ArtifactsPage() {
  const [selected, setSelected] = useState<ArtifactListItem | null>(null);
  const artifactsQuery = useQuery({ queryKey: ["artifacts"], queryFn: api.artifacts, refetchInterval: 8_000 });
  const artifacts = artifactsQuery.data?.artifacts ?? [];

  return (
    <div className="page">
      <header className="page-top compact">
        <div>
          <span className="eyebrow">产物</span>
          <h1>结果都放在这里，<em>随时可以查阅。</em></h1>
          <p className="page-lead">每个产物都有来源、大小和校验记录。点击即可预览，原件保存在本仓库的 `eval/runs` 中。</p>
        </div>
      </header>

      {artifacts.length === 0 ? (
        <section className="panel comfortable">
          <EmptyState icon={Package} title="还没有产物" body="任务完成后，生成的文档、表格和运行清单会按任务归档到这里。" />
        </section>
      ) : (
        <div className="artifact-grid">
          {artifacts.map((artifact) => {
            const Icon = artifact.mimeType.startsWith("image/") ? ImageIcon : artifact.mimeType.includes("json") ? FileJson : FileText;
            return (
              <button key={artifact.id} className="artifact-card" onClick={() => setSelected(artifact)}>
                <span className="artifact-card-icon"><Icon size={21} /></span>
                <span className="artifact-card-copy">
                  <strong>{artifact.relativePath.split("/").pop()}</strong>
                  <small>{artifact.taskTitle}</small>
                  <span>{artifact.relativePath}</span>
                </span>
                <span className="artifact-card-meta">
                  {formatBytes(artifact.bytes)}
                  <small>{relativeTime(artifact.createdAt)}</small>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {selected && <ArtifactPreview artifact={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
