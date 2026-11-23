import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, ChevronRight, Folder, HardDrive, Loader2, X } from "lucide-react";
import { api } from "../lib/api.ts";
import { desktopErrorMessage, hasDesktopBridge, pickFolder } from "../lib/desktop.ts";
import type { LocalProjectView } from "../lib/types.ts";

function normalizeFolderPath(input: string): string | null {
  const trimmed = input.trim().replace(/^["']|["']$/g, "").trim();
  if (!trimmed) return null;
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\") || trimmed.startsWith("/")) return trimmed;
  return null;
}

export function ProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: LocalProjectView) => void }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const pathRef = useRef<HTMLInputElement | null>(null);

  async function browse() {
    setError(null);
    // Desktop builds prefer the OS folder dialog. If the native picker is
    // unavailable (e.g. its IPC permission is missing), fall back to the
    // in-app browser instead of leaving the user with a dead-end error.
    if (hasDesktopBridge()) {
      try {
        const picked = await pickFolder();
        if (picked) {
          setPath(picked);
          if (!name.trim()) {
            const base = picked.split(/[\\/]/).filter(Boolean).pop() ?? "";
            if (base) setName(base);
          }
        }
      } catch (caught) {
        setError(`${desktopErrorMessage(caught, "无法打开系统文件夹选择器")}。已切换到内置文件夹浏览器。`);
        setBrowserOpen(true);
      }
      return;
    }
    setBrowserOpen(true);
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
            <button type="button" className="ghost-button" onClick={() => void browse()} disabled={busy}>选择文件夹</button>
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
        {browserOpen && (
          <FolderPicker
            initialPath={path}
            onClose={() => setBrowserOpen(false)}
            onPick={(picked) => {
              setPath(picked);
              setBrowserOpen(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

function FolderPicker({
  initialPath,
  onPick,
  onClose
}: {
  initialPath: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const initial = normalizeFolderPath(initialPath) ?? "";
  const [location, setLocation] = useState(initial);
  const [inputPath, setInputPath] = useState(initial);
  const foldersQuery = useQuery({
    queryKey: ["project-folders", location],
    queryFn: () => api.browseFolders(location || undefined),
    retry: false,
    staleTime: 5_000
  });
  const rootsFallbackQuery = useQuery({
    queryKey: ["project-folders", ""],
    queryFn: () => api.browseFolders(),
    enabled: foldersQuery.isError,
    staleTime: 60_000
  });
  const folders = foldersQuery.data?.folders;
  const roots = folders?.roots ?? rootsFallbackQuery.data?.folders.roots ?? [];

  useEffect(() => {
    if (!folders?.path) return;
    setLocation(folders.path);
    setInputPath(folders.path);
  }, [folders?.path]);

  function go(path: string) {
    const clean = path.trim();
    setLocation(clean);
    setInputPath(clean);
  }

  return (
    <div className="folder-picker-backdrop" role="presentation" onClick={(event) => {
      event.stopPropagation();
      onClose();
    }}>
      <div className="folder-picker" role="dialog" aria-modal="true" aria-label="选择文件夹" onClick={(event) => event.stopPropagation()}>
        <div className="folder-picker-head">
          <h3><Folder size={15} /> 选择文件夹</h3>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={14} /></button>
        </div>

        <div className="folder-picker-path">
          <button
            type="button"
            className="icon-button"
            onClick={() => folders?.parent && go(folders.parent)}
            disabled={!folders?.parent}
            title="上一级"
            aria-label="上一级"
          >
            <ArrowUp size={14} />
          </button>
          <input
            value={inputPath}
            onChange={(event) => setInputPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                go(inputPath);
              }
            }}
            placeholder="输入文件夹路径后回车"
            spellCheck={false}
          />
          <button type="button" className="ghost-button" onClick={() => go(inputPath)} disabled={!inputPath.trim()}>打开</button>
        </div>

        <div className="folder-picker-roots">
          {roots.map((root) => (
            <button key={root.path} type="button" className={`folder-root-chip${root.path === folders?.path ? " active" : ""}`} onClick={() => go(root.path)}>
              <HardDrive size={12} /> {root.name}
            </button>
          ))}
        </div>

        <div className="folder-picker-list">
          {foldersQuery.isLoading && <p className="folder-picker-note"><Loader2 size={13} className="spin" /> 正在读取…</p>}
          {foldersQuery.isError && <p className="form-error">{foldersQuery.error instanceof Error ? foldersQuery.error.message : "无法读取这个文件夹"}</p>}
          {!foldersQuery.isLoading && !foldersQuery.isError && folders?.entries.length === 0 && (
            <p className="folder-picker-note">这个文件夹里没有子文件夹，可以直接选择它。</p>
          )}
          {folders?.entries.map((entry) => (
            <button key={entry.path} type="button" className="folder-picker-row" onClick={() => go(entry.path)}>
              <Folder size={14} />
              <span>{entry.name}</span>
              <ChevronRight size={13} />
            </button>
          ))}
        </div>

        <div className="folder-picker-foot">
          <span title={folders?.path ?? undefined}>{folders?.path ?? "还没有选择文件夹"}</span>
          <div>
            <button className="ghost-button" onClick={onClose}>取消</button>
            <button className="primary-button" onClick={() => onPick(folders?.path ?? "")} disabled={!folders?.path}>选择此文件夹</button>
          </div>
        </div>
      </div>
    </div>
  );
}
