import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Code2, FileText, Globe2, Loader2, Megaphone, ShieldCheck, Sparkles, Table2, Users, X } from "lucide-react";
import { api } from "../lib/api.ts";
import { CATEGORY_LABELS } from "../lib/format.ts";
import type { TaskRecord, TaskTemplate } from "../lib/types.ts";

const CATEGORY_ICONS = {
  document: FileText,
  web: Globe2,
  code: Code2,
  data: Table2,
  people: Users,
  marketing: Megaphone
} as const;

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
  const [mode, setMode] = useState<"templates" | "custom">("templates");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

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
    createTask.mutate({ templateId: selected.id });
  }

  function submitCustom() {
    if (!description.trim() && !title.trim()) {
      setError("请至少写下你想完成的事情");
      return;
    }
    setError(null);
    createTask.mutate({
      title: title.trim() || "我的任务",
      goal: description.trim(),
      textInput: description.trim()
    });
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !createTask.isPending && onClose()}>
      <section className="new-task-modal" role="dialog" aria-modal="true" aria-labelledby="new-task-title">
        <header className="modal-header">
          <div>
            <span className="eyebrow"><Sparkles size={14} /> 新建任务</span>
            <h2 id="new-task-title">今天想让 Hearth 做什么？</h2>
            <p>选一个真实工作任务，或用自己的话描述。Hearth 会在本机执行并保存产物。</p>
          </div>
          <button className="icon-button" onClick={onClose} disabled={createTask.isPending} aria-label="关闭"><X size={20} /></button>
        </header>

        <div className="modal-tabs" role="tablist">
          <button className={mode === "templates" ? "active" : ""} onClick={() => setMode("templates")}>从任务库选择</button>
          <button className={mode === "custom" ? "active" : ""} onClick={() => setMode("custom")}>自己描述</button>
        </div>

        {mode === "templates" ? (
          <>
            <div className="category-filter">
              {CATEGORIES.map((item) => (
                <button key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>
                  {item === "all" ? "全部" : CATEGORY_LABELS[item]}
                </button>
              ))}
            </div>
            <div className="template-grid">
              {visibleTemplates.map((template) => {
                const Icon = CATEGORY_ICONS[template.category as keyof typeof CATEGORY_ICONS] ?? FileText;
                return (
                  <button
                    key={template.id}
                    className={`template-card ${selectedId === template.id ? "selected" : ""}`}
                    onClick={() => setSelectedId(template.id)}
                  >
                    <span className="template-icon"><Icon size={18} /></span>
                    <span className="template-copy">
                      <span className="template-title-row">
                        <strong>{template.title}</strong>
                        <span className="mono-chip">{template.id}</span>
                      </span>
                      <small>{template.description}</small>
                      <span className="template-meta">
                        {CATEGORY_LABELS[template.category] ?? template.category}
                        {template.approvalKind !== "none" && <em><ShieldCheck size={12} /> 外部写入需确认</em>}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <div className="custom-task-form">
            <label>
              <span>任务名称 <small>可选</small></span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：整理这周的客户反馈" maxLength={120} autoFocus />
            </label>
            <label>
              <span>你希望完成什么？</span>
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="写清楚目标、已有材料和你期望的结果。Hearth 会据此创建任务。" rows={7} maxLength={100_000} />
            </label>
          </div>
        )}

        {error && <p className="form-error">{error}</p>}

        <footer className="modal-footer">
          <div className="selection-summary">
            {mode === "templates" && selected ? (
              <><strong>{selected.title}</strong><span>{selected.goal}</span></>
            ) : mode === "templates" ? (
              <span>先选择一个任务，再开始处理。</span>
            ) : (
              <span>描述越具体，结果越接近你的预期。</span>
            )}
          </div>
          <button
            className="primary-button"
            onClick={mode === "templates" ? submitTemplate : submitCustom}
            disabled={createTask.isPending || (mode === "templates" ? !selected : !description.trim() && !title.trim())}
          >
            {createTask.isPending ? <><Loader2 size={16} className="spin" /> 正在创建</> : <>开始处理 <ArrowRight size={16} /></>}
          </button>
        </footer>
      </section>
    </div>
  );
}
