import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  XCircle
} from "lucide-react";
import { api } from "../lib/api.ts";
import { formatBytes } from "../lib/format.ts";
import { fileExtension, previewKind, TEXT_PREVIEW_LIMIT } from "../lib/preview.ts";
import type { ArtifactListItem, BackgroundToolJob, ChatAttachment, ChatMessageRecord, TaskListItem } from "../lib/types.ts";

interface PreviewTarget {
  name: string;
  url: string;
  mimeType: string;
  bytes: number | null;
  taskId?: string;
}

export function ChatWorkspacePanel({
  open,
  conversationId,
  messages,
  tasks,
  onOpen,
  onClose
}: {
  open: boolean;
  conversationId: string | null;
  messages: ChatMessageRecord[];
  tasks: TaskListItem[];
  onOpen: () => void;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const taskIds = useMemo(() => new Set(tasks.map((task) => task.id)), [tasks]);

  const artifactsQuery = useQuery({
    queryKey: ["artifacts"],
    queryFn: api.artifacts,
    enabled: open,
    refetchInterval: open ? 15_000 : false
  });
  const backgroundQuery = useQuery({
    queryKey: ["background-tools"],
    queryFn: () => api.backgroundTools({ limit: 50 }),
    enabled: open,
    refetchInterval: open ? 8_000 : false
  });
  useEffect(() => {
    setPreview(null);
  }, [conversationId]);

  if (!open) {
    return (
      <aside className="workspace-rail" aria-label="对话产物">
        <button className="workspace-rail-button" onClick={onOpen} title="展开对话产物" aria-label="展开对话产物">
          <PanelRightOpen size={16} />
          <span className="workspace-rail-label">产物</span>
        </button>
      </aside>
    );
  }

  const artifacts = (artifactsQuery.data?.artifacts ?? [])
    .filter((artifact) => taskIds.has(artifact.taskId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const attachments = collectAttachments(messages);
  const jobs = (backgroundQuery.data?.jobs ?? [])
    .filter((job) => taskIds.has(job.taskId))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const hasContent = artifacts.length > 0 || attachments.length > 0 || jobs.length > 0;

  return (
    <aside className="workspace-panel" aria-label="对话产物">
      <header className="workspace-head">
        {preview ? (
          <button className="icon-button" onClick={() => setPreview(null)} aria-label="返回产物" title="返回产物">
            <ArrowLeft size={15} />
          </button>
        ) : (
          <PanelRightOpen size={15} className="workspace-head-mark" />
        )}
        <h2 title={preview?.name ?? "对话产物"}>{preview?.name ?? "对话产物"}</h2>
        <button className="icon-button" onClick={onClose} aria-label="收起产物" title="收起">
          <PanelRightClose size={15} />
        </button>
      </header>

      {preview ? (
        <PreviewBody preview={preview} onClose={() => setPreview(null)} />
      ) : (
        <div className="workspace-scroll">
          {artifacts.length > 0 && (
            <section className="workspace-section">
              <h3>对话产物<span>{artifacts.length}</span></h3>
              <ul className="workspace-list">
                {artifacts.map((artifact) => (
                  <li key={artifact.id}>
                    <button className="workspace-row" onClick={() => setPreview(artifactTarget(artifact))}>
                      <FileBadge name={artifact.relativePath} />
                      <span className="workspace-row-title">{fileName(artifact.relativePath)}</span>
                      <span className="workspace-row-meta">{formatBytes(artifact.bytes)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {attachments.length > 0 && (
            <section className="workspace-section">
              <h3>对话资源<span>{attachments.length}</span></h3>
              <ul className="workspace-list">
                {attachments.map((attachment) => (
                  <li key={attachment.id}>
                    <button className="workspace-row" onClick={() => setPreview(attachmentTarget(attachment))}>
                      <FileBadge name={attachment.name} />
                      <span className="workspace-row-title">{attachment.name}</span>
                      <span className="workspace-row-meta">{formatBytes(attachment.bytes)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {jobs.length > 0 && (
            <section className="workspace-section">
              <h3>后台命令<span>{jobs.length}</span></h3>
              <ul className="workspace-list">
                {jobs.slice(0, 6).map((job) => (
                  <li key={job.id}>
                    <div className="workspace-row" title={jobCommand(job)}>
                      <JobBadge job={job} />
                      <span className="workspace-row-title">{job.toolName}</span>
                      <span className={`workspace-row-meta job-${job.status}`}>{jobStatusLabel(job.status)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!hasContent && (
            <p className="workspace-empty">对话产生文件或产物后，会显示在这里。</p>
          )}
        </div>
      )}
    </aside>
  );
}

function PreviewBody({ preview, onClose }: { preview: PreviewTarget; onClose: () => void }) {
  const kind = previewKind(preview.name, preview.mimeType);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tooLarge = preview.bytes !== null && preview.bytes > TEXT_PREVIEW_LIMIT;

  useEffect(() => {
    setContent(null);
    setError(null);
    if (kind !== "text" && kind !== "markdown") return;
    if (tooLarge) return;
    const controller = new AbortController();
    let cancelled = false;
    fetch(preview.url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`读取失败（${response.status}）`);
        return response.text();
      })
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((caught) => {
        if (!cancelled && !(caught instanceof DOMException && caught.name === "AbortError")) {
          setError(caught instanceof Error ? caught.message : "读取失败");
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [preview.url, kind, tooLarge]);

  return (
    <>
      <div className="workspace-preview-bar">
        <span>{fileExtension(preview.name)} · {preview.bytes === null ? "—" : formatBytes(preview.bytes)}</span>
        <div>
          <a className="workspace-preview-link" href={preview.url} download={preview.name} title="下载">
            <Download size={13} /> 下载
          </a>
        </div>
      </div>
      <div className={`workspace-preview-body kind-${kind}`}>
        {kind === "image" && <img src={preview.url} alt={preview.name} />}
        {kind === "pdf" && <iframe src={preview.url} title={preview.name} />}
        {(kind === "text" || kind === "markdown") && (
          <>
            {tooLarge && <p className="workspace-empty">文件较大，已停止内联加载。请下载后查看。</p>}
            {error && <p className="form-error">{error}</p>}
            {content === null && !error && !tooLarge && <p className="workspace-muted"><Loader2 size={13} className="spin" /> 正在读取</p>}
            {content !== null && kind === "markdown" && (
              <div className="chat-markdown result-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              </div>
            )}
            {content !== null && kind === "text" && <pre className="workspace-text">{content}</pre>}
          </>
        )}
        {kind === "binary" && (
          <div className="workspace-empty">
            <p>这种格式暂不支持内联预览。</p>
            <a className="ghost-button" href={preview.url} download={preview.name}><Download size={13} /> 下载文件</a>
          </div>
        )}
      </div>
    </>
  );
}

function FileBadge({ name }: { name: string }) {
  return <span className="workspace-file-badge">{fileExtension(name).slice(0, 4)}</span>;
}

function JobBadge({ job }: { job: BackgroundToolJob }) {
  if (job.status === "running" || job.status === "queued") return <Loader2 size={13} className="spin" />;
  if (job.status === "failed" || job.status === "stopped") return <XCircle size={13} className="workspace-warn" />;
  return <CheckCircle2 size={13} className="workspace-ok" />;
}

function artifactTarget(artifact: ArtifactListItem): PreviewTarget {
  return {
    name: fileName(artifact.relativePath),
    url: api.artifactUrl(artifact.taskId, artifact.id),
    mimeType: artifact.mimeType,
    bytes: artifact.bytes,
    taskId: artifact.taskId
  };
}

function attachmentTarget(attachment: ChatAttachment): PreviewTarget {
  return {
    name: attachment.name,
    url: api.attachmentUrl(attachment.id),
    mimeType: attachment.mimeType,
    bytes: attachment.bytes
  };
}

function collectAttachments(messages: ChatMessageRecord[]): ChatAttachment[] {
  const seen = new Set<string>();
  const result: ChatAttachment[] = [];
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (seen.has(attachment.id)) continue;
      seen.add(attachment.id);
      result.push(attachment);
    }
  }
  return result.reverse();
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function jobStatusLabel(status: BackgroundToolJob["status"]): string {
  switch (status) {
    case "queued": return "排队";
    case "running": return "运行中";
    case "finished": return "完成";
    case "failed": return "失败";
    default: return "已停止";
  }
}

function jobCommand(job: BackgroundToolJob): string {
  const command = job.args["command"] ?? job.args["cmd"] ?? job.args["script"];
  return typeof command === "string" ? command : job.toolName;
}
