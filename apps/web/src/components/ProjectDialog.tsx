import { useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { api } from "../lib/api.ts";
import { hasDesktopBridge, pickFolder } from "../lib/desktop.ts";
import type { LocalProjectView } from "../lib/types.ts";

export function normalizeFolderPath(input: string): string | null {
  const trimmed = input.trim().replace(/^["']|["']$/g, "").trim();
  if (!trimmed) return null;
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\")) return trimmed;
  return null;
}

export function ProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: LocalProjectView) => void }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerUnavailable, setPickerUnavailable] = useState(() => !hasDesktopBridge());
  const pathRef = useRef<HTMLInputElement | null>(null);

  async function browse() {
    setError(null);
    if (!hasDesktopBridge()) {
      setPickerUnavailable(true);
      setError("当前不在桌面版中，请直接粘贴完整的文件夹路径。");
      pathRef.current?.focus();
      return;
    }
    try {
      const picked = await pickFolder();
      if (picked) setPath(picked);
    } catch {
      setPickerUnavailable(true);
      setError("系统选择器不可用，请直接粘贴完整的文件夹路径。");
      pathRef.current?.focus();
    }
  }

  async function create() {
    const normalized = normalizeFolderPath(path);
    if (!normalized) {
      setError("请填写完整的文件夹路径，例如 D:\\Projects\\my-app");
      pathRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const trimmedName = name.trim();
      const result = await api.createProject({
        path: normalized,
        ...(trimmedName ? { name: trimmedName } : {})
      });
      onCreated(result.project);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建项目失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="project-dialog" role="dialog" aria-modal="true" aria-label="创建项目" onClick={(event) => event.stopPropagation()}>
        <div className="project-dialog-head">
          <h2>创建项目</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={14} /></button>
        </div>
        <label className="project-field">
          <span>项目名称</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="留空则使用文件夹名"
            autoFocus
          />
        </label>
        <label className="project-field">
          <span>源文件夹</span>
          <div className="project-path-row">
            <input ref={pathRef} value={path} onChange={(event) => setPath(event.target.value)} placeholder="D:\Projects\my-app" spellCheck={false} />
            {!pickerUnavailable && (
              <button type="button" className="ghost-button" onClick={() => void browse()} disabled={busy}>浏览…</button>
            )}
          </div>
        </label>
        <p className="project-dialog-note">支持 Git 仓库或任意本地文件夹。</p>
        {error && <p className="form-error">{error}</p>}
        <div className="project-dialog-actions">
          <button className="ghost-button" onClick={onClose} disabled={busy}>取消</button>
          <button className="primary-button" onClick={() => void create()} disabled={busy || !path.trim()}>
            {busy ? <Loader2 size={14} className="spin" /> : null} 创建项目
          </button>
        </div>
      </div>
    </div>
  );
}
