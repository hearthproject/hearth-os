import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  ExternalLink,
  FolderDown,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  X,
  XCircle
} from "lucide-react";
import { api } from "../lib/api.ts";
import { Markdown } from "./Markdown.tsx";
import { desktopErrorMessage, hasDesktopBridge, openInBrowser, pickFolder } from "../lib/desktop.ts";
import { formatBytes } from "../lib/format.ts";
import { fileExtension, OFFICE_PREVIEW_LIMIT, previewKind, TEXT_PREVIEW_LIMIT } from "../lib/preview.ts";
import { parseDelimited, parseDocx, parsePptx, parseXlsx, type SheetTable, type SlideText } from "../lib/office-preview.ts";
import { artifactPreviewTarget, attachmentPreviewTarget, fileName, type PreviewTarget } from "../lib/workspace-preview.ts";
import type { BackgroundToolJob, ChatAttachment, ChatMessageRecord, TaskListItem } from "../lib/types.ts";

export type { PreviewTarget } from "../lib/workspace-preview.ts";

export function ChatWorkspacePanel({
  open,
  messages,
  tasks,
  preview,
  tabs,
  activeKey,
  onSelectTab,
  onCloseTab,
  onShowList,
  onOpenPreview,
  onOpen,
  onClose
}: {
  open: boolean;
  messages: ChatMessageRecord[];
  tasks: TaskListItem[];
  preview: PreviewTarget | null;
  tabs: PreviewTarget[];
  activeKey: string | null;
  onSelectTab: (key: string) => void;
  onCloseTab: (key: string) => void;
  onShowList: () => void;
  onOpenPreview: (preview: PreviewTarget) => void;
  onOpen: () => void;
  onClose: () => void;
}) {
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
          <button className="icon-button" onClick={onShowList} aria-label="返回产物" title="返回产物">
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

      {tabs.length > 0 && (
        <div className="workspace-tabs" role="tablist" aria-label="已打开的预览">
          {tabs.map((tab) => {
            const key = previewKey(tab);
            return (
              <div key={key} className={`workspace-tab${key === activeKey ? " active" : ""}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={key === activeKey}
                  className="workspace-tab-main"
                  onClick={() => onSelectTab(key)}
                  title={tab.name}
                >
                  <FileBadge name={tab.name} />
                  <span>{tab.name}</span>
                </button>
                <button
                  type="button"
                  className="workspace-tab-close"
                  onClick={() => onCloseTab(key)}
                  aria-label={`关闭 ${tab.name}`}
                  title={`关闭 ${tab.name}`}
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {preview ? (
        <PreviewBody key={activeKey ?? preview.url} preview={preview} />
      ) : (
        <div className="workspace-scroll">
          {artifacts.length > 0 && (
            <section className="workspace-section">
              <h3>对话产物<span>{artifacts.length}</span></h3>
              <ul className="workspace-list">
                {artifacts.map((artifact) => (
                  <li key={artifact.id}>
                    <button className="workspace-row" onClick={() => onOpenPreview(artifactPreviewTarget(artifact))}>
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
                    <button className="workspace-row" onClick={() => onOpenPreview(attachmentPreviewTarget(attachment))}>
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

function PreviewBody({ preview }: { preview: PreviewTarget }) {
  const kind = previewKind(preview.name, preview.mimeType);
  const [content, setContent] = useState<string | null>(null);
  const [office, setOffice] = useState<
    | { kind: "sheet"; tables: SheetTable[] }
    | { kind: "slides"; slides: SlideText[] }
    | { kind: "doc"; paragraphs: string[] }
    | null
  >(null);
  const [officeBusy, setOfficeBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const isOffice = kind === "sheet" || kind === "slides" || kind === "doc";
  const limit = isOffice ? OFFICE_PREVIEW_LIMIT : TEXT_PREVIEW_LIMIT;
  const tooLarge = preview.bytes !== null && preview.bytes > limit;

  useEffect(() => {
    setContent(null);
    setOffice(null);
    setOfficeBusy(false);
    setError(null);
    setExportMessage(null);
    if (tooLarge) return;
    if (kind !== "text" && kind !== "markdown" && !isOffice) return;
    const controller = new AbortController();
    let cancelled = false;
    const fail = (caught: unknown) => {
      if (!cancelled && !(caught instanceof DOMException && caught.name === "AbortError")) {
        setError(caught instanceof Error ? caught.message : "读取失败");
      }
    };

    if (isOffice) {
      setOfficeBusy(true);
      (async () => {
        const response = await fetch(preview.url, { signal: controller.signal });
        if (!response.ok) throw new Error(`读取失败（${response.status}）`);
        if (kind === "sheet" && /\.(csv|tsv)$/i.test(preview.name)) {
          const text = await response.text();
          const rows = /\.tsv$/i.test(preview.name)
            ? text.replace(/\r\n/g, "\n").split("\n").slice(0, 200).map((line) => line.split("\t").slice(0, 24))
            : parseDelimited(text);
          return { kind: "sheet" as const, tables: [{ name: preview.name, rows }] };
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (kind === "sheet") return { kind: "sheet" as const, tables: parseXlsx(bytes) };
        if (kind === "slides") return { kind: "slides" as const, slides: parsePptx(bytes) };
        return { kind: "doc" as const, paragraphs: parseDocx(bytes) };
      })()
        .then((result) => {
          if (!cancelled) setOffice(result);
        })
        .catch(fail)
        .finally(() => {
          if (!cancelled) setOfficeBusy(false);
        });
    } else {
      fetch(preview.url, { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error(`读取失败（${response.status}）`);
          return response.text();
        })
        .then((text) => {
          if (!cancelled) setContent(text);
        })
        .catch(fail);
    }
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [preview.url, preview.name, kind, isOffice, tooLarge]);

  async function handleExport() {
    if (!preview.taskId || !preview.artifactId || exporting) return;
    setExporting(true);
    setExportMessage(null);
    try {
      const folder = await pickFolder();
      if (!folder) return;
      const result = await api.exportArtifact(preview.taskId, preview.artifactId, folder);
      setExportMessage(`已保存到 ${result.path}`);
    } catch (caught) {
      setExportMessage(`保存失败：${desktopErrorMessage(caught, "未知错误")}`);
    } finally {
      setExporting(false);
    }
  }

  async function handleBrowserOpen() {
    setExportMessage(null);
    try {
      await openInBrowser(preview.url);
    } catch (caught) {
      setExportMessage(`打开浏览器失败：${desktopErrorMessage(caught, "未知错误")}`);
    }
  }

  return (
    <>
      <div className="workspace-preview-bar">
        <span>{fileExtension(preview.name)} · {preview.bytes === null ? "—" : formatBytes(preview.bytes)}</span>
        <div>
          <button
            type="button"
            className="workspace-preview-link"
            onClick={() => void handleBrowserOpen()}
            title="在系统默认浏览器中打开"
          >
            <ExternalLink size={13} /> 浏览器打开
          </button>
          {preview.artifactId && hasDesktopBridge() && (
            <button
              type="button"
              className="workspace-preview-link"
              onClick={handleExport}
              disabled={exporting}
              title="另存到文件夹"
            >
              <FolderDown size={13} /> {exporting ? "保存中…" : "另存到"}
            </button>
          )}
          <a className="workspace-preview-link" href={preview.url} download={preview.name} title="下载">
            <Download size={13} /> 下载
          </a>
        </div>
      </div>
      {exportMessage && <p className="workspace-muted">{exportMessage}</p>}
      <div className={`workspace-preview-body kind-${kind}`}>
        {kind === "image" && <img src={preview.url} alt={preview.name} />}
        {kind === "video" && (
          <video className="workspace-video" src={preview.url} controls preload="metadata" title={preview.name}>
            <track kind="captions" />
          </video>
        )}
        {kind === "audio" && <audio className="workspace-audio" src={preview.url} controls preload="metadata" title={preview.name} />}
        {kind === "pdf" && <iframe src={preview.url} title={preview.name} />}
        {(kind === "text" || kind === "markdown") && (
          <>
            {tooLarge && <p className="workspace-empty">文件较大，已停止内联加载。请下载后查看。</p>}
            {error && <p className="form-error">{error}</p>}
            {content === null && !error && !tooLarge && <p className="workspace-muted"><Loader2 size={13} className="spin" /> 正在读取</p>}
            {content !== null && kind === "markdown" && (
              <Markdown className="chat-markdown result-markdown">{content}</Markdown>
            )}
            {content !== null && kind === "text" && <pre className="workspace-text">{content}</pre>}
          </>
        )}
        {(kind === "sheet" || kind === "slides" || kind === "doc") && (
          <>
            {tooLarge && <p className="workspace-empty">文件较大（超过 40 MB），已停止内联解析。请下载后查看。</p>}
            {error && <p className="form-error">{error}</p>}
            {officeBusy && !office && (
              <p className="workspace-muted"><Loader2 size={13} className="spin" /> 正在解析 Office 文件…</p>
            )}
            {office?.kind === "sheet" && <SheetPreview tables={office.tables} />}
            {office?.kind === "slides" && <SlidesPreview slides={office.slides} />}
            {office?.kind === "doc" && (
              <div className="workspace-doc">
                {office.paragraphs.map((paragraph, index) => <p key={`${index}:${paragraph.slice(0, 12)}`}>{paragraph}</p>)}
              </div>
            )}
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

function SheetPreview({ tables }: { tables: SheetTable[] }) {
  if (tables.length === 0) return <p className="workspace-empty">工作表里没有可显示的内容。</p>;
  return (
    <div className="workspace-sheet">
      {tables.map((table) => (
        <section key={table.name}>
          <h3>{table.name}<span>{Math.max(0, table.rows.length - 1)} 行</span></h3>
          {table.rows.length === 0 ? (
            <p className="workspace-empty">空表</p>
          ) : (
            <div className="workspace-sheet-scroll">
              <table>
                <tbody>
                  {table.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className={rowIndex === 0 ? "head" : undefined}>
                      {(row.length > 0 ? row : [""]).map((cell, cellIndex) => (
                        <td key={cellIndex}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function SlidesPreview({ slides }: { slides: SlideText[] }) {
  if (slides.length === 0) return <p className="workspace-empty">没有读取到幻灯片内容。</p>;
  return (
    <div className="workspace-slides">
      {slides.map((slide) => (
        <section key={slide.index} className="workspace-slide">
          <header><span>第 {slide.index} 页</span></header>
          {slide.lines.length === 0
            ? <p className="workspace-muted">这一页只有图形或图片。</p>
            : slide.lines.map((line, index) => (
              <p key={`${index}:${line.slice(0, 10)}`} className={index === 0 ? "workspace-slide-title" : undefined}>{line}</p>
            ))}
        </section>
      ))}
    </div>
  );
}

function FileBadge({ name }: { name: string }) {
  return <span className="workspace-file-badge">{fileExtension(name).slice(0, 4)}</span>;
}

function previewKey(preview: PreviewTarget): string {
  return `${preview.name}::${preview.url}`;
}

function JobBadge({ job }: { job: BackgroundToolJob }) {
  if (job.status === "running" || job.status === "queued") return <Loader2 size={13} className="spin" />;
  if (job.status === "failed" || job.status === "stopped") return <XCircle size={13} className="workspace-warn" />;
  return <CheckCircle2 size={13} className="workspace-ok" />;
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
