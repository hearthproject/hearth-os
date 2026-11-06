import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Loader2, X } from "lucide-react";
import { api } from "../lib/api.ts";
import { abbreviateHash, relativeTime } from "../lib/format.ts";
import { CATEGORY_LABELS, approvalKindLabel } from "../lib/labels.ts";
import type { SourceConnection, SourceItem, TaskRecord, TaskTemplate } from "../lib/types.ts";
import { useViewMode } from "../lib/view-mode.tsx";

const CATEGORIES = ["all", "document", "web", "code", "data", "people", "marketing"] as const;

export function NewTaskModal({
  open,
  templates,
  onClose,
  onCreated
}: {
  open: boolean;
  templates: TaskTemplate[];
  onClose: () => void;
  onCreated: (task: TaskRecord) => void;
}) {
  const queryClient = useQueryClient();
  const { mode: viewMode } = useViewMode();
  const [tab, setTab] = useState<"templates" | "custom">("templates");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedSourceItemIds, setSelectedSourceItemIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sourcesQuery = useQuery({ queryKey: ["sources"], queryFn: api.sources, enabled: open });
  const readyItemsQuery = useQuery({ queryKey: ["readySourceItems"], queryFn: () => api.readySourceItems(), enabled: open });

  const selected = templates.find((template) => template.id === selectedId) ?? null;
  const visibleTemplates = useMemo(
    () => category === "all" ? templates : templates.filter((template) => template.category === category),
    [category, templates]
  );

  const createTask = useMutation({
    mutationFn: api.createTask,
    onSuccess: (task) => {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      setSelectedId(null);
      setTitle("");
      setDescription("");
      setSelectedSourceItemIds([]);
      setError(null);
      onCreated(task);
    },
    onError: (mutationError) => setError(mutationError instanceof Error ? mutationError.message : "创建任务失败")
  });

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !createTask.isPending) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("modal-open");
    };
  }, [createTask.isPending, onClose, open]);

  if (!open) return null;

  function submitTemplate() {
    if (!selected) return;
    setError(null);
    createTask.mutate({
      templateId: selected.id,
      ...(selectedSourceItemIds.length > 0 ? { sourceItemIds: selectedSourceItemIds } : {})
    });
  }

  function submitCustom() {
    if (!description.trim() && !title.trim()) {
      setError("请写下你想完成的事情");
      return;
    }
    setError(null);
    createTask.mutate({
      title: title.trim() || "我的任务",
      goal: description.trim(),
      textInput: description.trim(),
      ...(selectedSourceItemIds.length > 0 ? { sourceItemIds: selectedSourceItemIds } : {})
    });
  }

  function toggleSourceItem(id: string) {
    setSelectedSourceItemIds((current) => current.includes(id)
      ? current.filter((itemId) => itemId !== id)
      : current.length >= 20 ? current : [...current, id]);
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !createTask.isPending && onClose()}>
      <section className="new-task-modal" role="dialog" aria-modal="true" aria-labelledby="new-task-title">
        <header className="modal-header">
          <h2 id="new-task-title">新建任务</h2>
          <button className="icon-button" onClick={onClose} disabled={createTask.isPending} aria-label="关闭"><X size={18} /></button>
        </header>

        <div className="modal-tabs" role="tablist">
          <button className={tab === "templates" ? "active" : ""} onClick={() => setTab("templates")}>任务库</button>
          <button className={tab === "custom" ? "active" : ""} onClick={() => setTab("custom")}>自己描述</button>
        </div>

        {tab === "templates" ? (
          <>
            <div className="category-filter">
              {CATEGORIES.map((item) => (
                <button key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>
                  {item === "all" ? "全部" : CATEGORY_LABELS[item]}
                </button>
              ))}
            </div>
            <ul className="template-list">
              {visibleTemplates.map((template) => (
                <li key={template.id}>
                  <button
                    className={`list-row template-row ${selectedId === template.id ? "selected" : ""}`}
                    onClick={() => setSelectedId(template.id)}
                  >
                    <span className="mono">{template.id}</span>
                    <span className="grow">
                      <strong>{template.title}</strong>
                      <small>{template.description}</small>
                    </span>
                    <span className="subtle">{CATEGORY_LABELS[template.category] ?? template.category}</span>
                    {template.approvalKind !== "none" && <span className="tag">需确认</span>}
                  </button>
                </li>
              ))}
            </ul>
            {viewMode === "pro" && selected && <TemplateDetail template={selected} />}
          </>
        ) : (
          <div className="custom-task-form">
            <label>
              <span>任务名称 <small>可选</small></span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：整理这周的客户反馈" maxLength={120} autoFocus />
            </label>
            <label>
              <span>你希望完成什么？</span>
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="目标、已有材料、期望结果。" rows={7} maxLength={100_000} />
            </label>
          </div>
        )}

        <SourcePicker
          sources={sourcesQuery.data?.sources ?? []}
          items={readyItemsQuery.data?.items ?? []}
          selectedIds={selectedSourceItemIds}
          loading={sourcesQuery.isLoading || readyItemsQuery.isLoading}
          pro={viewMode === "pro"}
          onToggle={toggleSourceItem}
        />

        {error && <p className="form-error">{error}</p>}

        <footer className="modal-footer">
          <div className="selection-summary">
            <span>
              {tab === "templates" && selected ? <strong>{selected.title}</strong> : "选择模板，或填写目标。"}
              {selectedSourceItemIds.length > 0 && <> · 已附加 {selectedSourceItemIds.length} 项资料</>}
            </span>
          </div>
          <button
            className="primary-button"
            onClick={tab === "templates" ? submitTemplate : submitCustom}
            disabled={createTask.isPending || (tab === "templates" ? !selected : !description.trim() && !title.trim())}
          >
            {createTask.isPending ? <><Loader2 size={15} className="spin" /> 正在创建</> : "创建任务"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function SourcePicker({
  sources,
  items,
  selectedIds,
  loading,
  pro,
  onToggle
}: {
  sources: SourceConnection[];
  items: SourceItem[];
  selectedIds: string[];
  loading: boolean;
  pro: boolean;
  onToggle: (id: string) => void;
}) {
  const sourceById = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);
  const available = items.filter((item) => sourceById.has(item.sourceId));

  return (
    <details className="task-source-picker" open={selectedIds.length > 0 || undefined}>
      <summary>
        <span><BookOpen size={15} /> 附加已读取资料</span>
        <span>{selectedIds.length > 0 ? `已选 ${selectedIds.length} 项` : "只读 · 可选"}</span>
      </summary>
      {loading ? (
        <p className="task-source-empty">正在读取可用资料…</p>
      ) : available.length === 0 ? (
        <p className="task-source-empty">还没有已读取资料。先到“来源”读取本地文件、知识库或公开网页。</p>
      ) : (
        <ul className="task-source-list">
          {available.map((item) => {
            const source = sourceById.get(item.sourceId);
            const checked = selectedIds.includes(item.id);
            const disabled = !checked && selectedIds.length >= 20;
            return (
              <li key={item.id}>
                <label className={`task-source-option ${checked ? "selected" : ""} ${disabled ? "disabled" : ""}`}>
                  <input type="checkbox" checked={checked} disabled={disabled} onChange={() => onToggle(item.id)} />
                  <span className="task-source-copy">
                    <strong>{item.title || item.label}</strong>
                    <small>{source?.displayName} · {relativeTime(item.fetchedAt)}</small>
                    {pro && <small className="mono">{item.locator} · {item.contentHash ? abbreviateHash(item.contentHash, 10, 6) : "无正文哈希"}</small>}
                  </span>
                  <span className="tag">只读</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}

function TemplateDetail({ template }: { template: TaskTemplate }) {
  return (
    <dl className="kv-grid template-detail">
      <div><dt>目标</dt><dd>{template.goal}</dd></div>
      <div><dt>输出目录</dt><dd className="mono select-all">{template.outputDir}</dd></div>
      <div><dt>交付标准</dt><dd className="mono">{template.expectedOutputs.join("、")}</dd></div>
      <div><dt>外部动作</dt><dd>{template.approvalKind === "none" ? "无" : approvalKindLabel(template.approvalKind)}</dd></div>
      <div>
        <dt>允许联网</dt>
        <dd className="mono">{template.networkHosts.length > 0 ? template.networkHosts.join("、") : "禁用"}</dd>
      </div>
      <div>
        <dt>验收标准</dt>
        <dd><ul className="plain-list">{template.acceptance.map((item) => <li key={item}>{item}</li>)}</ul></dd>
      </div>
    </dl>
  );
}
