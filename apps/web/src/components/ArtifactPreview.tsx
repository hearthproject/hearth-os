import { useEffect, useState } from "react";
import { Download, ExternalLink, FileJson, FileText, Image as ImageIcon, Loader2, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../lib/api.ts";
import { formatBytes } from "../lib/format.ts";
import type { PreviewableArtifact } from "../lib/types.ts";

export function ArtifactPreview({ artifact, onClose }: { artifact: PreviewableArtifact; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = api.artifactUrl(artifact.taskId, artifact.id);
  const isMarkdown = artifact.mimeType.startsWith("text/markdown");
  const isText = artifact.mimeType.startsWith("text/") || artifact.mimeType.includes("json");
  const isImage = artifact.mimeType.startsWith("image/");
  const isPdf = artifact.mimeType === "application/pdf";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("modal-open");
    };
  }, [onClose]);

  useEffect(() => {
    if (!isText) return;
    let cancelled = false;
    setContent(null);
    setError(null);
    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error("无法读取产物");
        return response.text();
      })
      .then((text) => !cancelled && setContent(text))
      .catch((fetchError) => !cancelled && setError(fetchError instanceof Error ? fetchError.message : "无法读取产物"));
    return () => { cancelled = true; };
  }, [isText, url]);

  return (
    <div className="modal-backdrop preview-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="artifact-modal" role="dialog" aria-modal="true" aria-label={artifact.relativePath}>
        <header className="artifact-modal-header">
          <div className="artifact-title">
            <span className="artifact-icon">{isImage ? <ImageIcon size={20} /> : artifact.mimeType.includes("json") ? <FileJson size={20} /> : <FileText size={20} />}</span>
            <div>
              <h2>{artifact.relativePath.split("/").pop()}</h2>
              <p>{artifact.relativePath} · {formatBytes(artifact.bytes)} · {artifact.mimeType.split(";")[0]}</p>
            </div>
          </div>
          <div className="artifact-actions">
            <a className="ghost-button" href={url} target="_blank" rel="noreferrer"><ExternalLink size={16} /> 新窗口</a>
            <a className="ghost-button" href={url} download><Download size={16} /> 下载</a>
            <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button>
          </div>
        </header>

        <div className="artifact-modal-body">
          {isImage && <img className="artifact-image" src={url} alt={artifact.relativePath} />}
          {isPdf && <iframe className="artifact-frame" src={url} title={artifact.relativePath} />}
          {!isImage && !isPdf && isMarkdown && content !== null && (
            <article className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </article>
          )}
          {!isImage && !isPdf && !isMarkdown && isText && (
            <pre className="artifact-text">{content ?? (error ? error : "正在读取…")}</pre>
          )}
          {!isText && !isImage && !isPdf && (
            <div className="artifact-unavailable">
              <FileText size={34} />
              <p>这个文件不能直接预览，请下载后打开。</p>
              <a className="primary-button" href={url} download><Download size={16} /> 下载文件</a>
            </div>
          )}
          {error && <p className="form-error">{error}</p>}
          {isText && content === null && !error && <div className="preview-loading"><Loader2 className="spin" size={20} /> 正在读取产物</div>}
        </div>
      </section>
    </div>
  );
}
