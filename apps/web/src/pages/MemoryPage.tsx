import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Check, Download, EyeOff, Pencil, Save, ShieldAlert, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState } from "../components/EmptyState.tsx";
import { api } from "../lib/api.ts";
import { formatDate, relativeTime } from "../lib/format.ts";
import type {
  CorrectMemoryRequest,
  CreateMemoryRequest,
  MemoryConflict,
  MemoryKind,
  MemoryRecord,
  MemorySnapshot
} from "../lib/types.ts";

const KIND_LABELS: Record<MemoryKind, string> = {
  fact: "事实",
  preference: "偏好",
  project: "项目",
  commitment: "承诺",
  experience: "经历",
  method: "方法"
};

const STATUS_LABELS: Record<MemoryRecord["status"], string> = {
  candidate: "待确认",
  active: "已启用",
  conflict: "冲突",
  forgotten: "已遗忘",
  superseded: "已替代"
};

const SENSITIVITY_LABELS = { normal: "普通", sensitive: "敏感", secret: "机密" };

export function MemoryPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<"candidate" | "active" | "all">("candidate");
  const [notice, setNotice] = useState<string | null>(null);
  const snapshotQuery = useQuery({ queryKey: ["memory"], queryFn: api.memory, refetchInterval: 20_000 });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["memory"] });

  const actionMutation = useMutation({
    mutationFn: async (input: { action: string; id: string; payload?: unknown }) => {
      if (input.action === "confirm") return api.confirmMemory(input.id);
      if (input.action === "forget") return api.forgetMemory(input.id);
      if (input.action === "correct") return api.correctMemory(input.id, input.payload as CorrectMemoryRequest);
      if (input.action === "sensitive") return api.markMemorySensitive(input.id, "sensitive", false);
      if (input.action === "unsensitive") return api.markMemorySensitive(input.id, "normal", true);
      return api.resolveMemoryConflict(input.id, input.payload as { resolution: "keep_left" | "keep_right" | "merged"; note?: string; content?: string });
    },
    onSuccess: (_result, input) => {
      setNotice(actionNotice(input.action));
      refresh();
    }
  });

  const snapshot = snapshotQuery.data;
  const pendingConflicts = snapshot?.conflicts.filter((item) => item.status === "pending") ?? [];
  const memories = (snapshot?.memories ?? []).filter((memory) => {
    if (filter === "all") return true;
    return memory.status === filter;
  });

  return (
    <div className="page memory-page">
      <div className="page-head">
        <h1>记忆</h1>
        <span className="page-meta">记忆只提供背景，不是事实源，也不能扩大权限。</span>
        <button className="ghost-button" onClick={api.exportMemories}><Download size={15} /> 导出全部记忆</button>
      </div>

      {snapshotQuery.isLoading && <p className="section-empty">正在读取记忆…</p>}
      {snapshotQuery.isError && <p className="form-error">{snapshotQuery.error.message}</p>}
      {notice && <p className="page-meta">{notice}</p>}

      {snapshot && (
        <>
          <MemoryCreateForm onCreate={(input) => {
            api.createMemory(input).then(() => { setNotice("已创建记忆候选，确认后才会被召回。"); refresh(); }).catch((error: Error) => setNotice(error.message));
          }} />

          <MemorySettingsPanel settings={snapshot.settings} onSave={(input, done) => {
            api.updateMemorySettings(input).then(() => { setNotice("记忆设置已保存。"); refresh(); done(); }).catch((error: Error) => setNotice(error.message));
          }} />

          {pendingConflicts.length > 0 && (
            <section className="panel memory-conflicts">
              <div className="panel-head"><h2>需要解决的冲突</h2><span className="panel-meta">{pendingConflicts.length} 条</span></div>
              {pendingConflicts.map((conflict) => (
                <ConflictCard key={conflict.id} conflict={conflict} memories={snapshot.memories} busy={actionMutation.isPending} onResolve={(input) => actionMutation.mutate({ action: "resolve", id: conflict.id, payload: input })} />
              ))}
            </section>
          )}

          <div className="inbox-toolbar">
            <div className="segmented">
              <button className={filter === "candidate" ? "active" : ""} onClick={() => setFilter("candidate")}>待确认</button>
              <button className={filter === "active" ? "active" : ""} onClick={() => setFilter("active")}>已启用</button>
              <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部</button>
            </div>
            <span className="page-meta">召回预算 {snapshot.settings.maxItems} 条 / {snapshot.settings.maxChars} 字符</span>
          </div>

          {actionMutation.error && <p className="form-error">{actionMutation.error.message}</p>}

          {memories.length === 0 ? (
            <section className="panel"><EmptyState title="这里还没有记忆" body="用户明确提供的事实、偏好和项目背景会先进入候选，确认后才参与召回。" /></section>
          ) : (
            <div className="memory-list">
              {memories.map((memory) => (
                <MemoryCard key={memory.id} memory={memory} busy={actionMutation.isPending} onAction={(action, payload) => actionMutation.mutate({ action, id: memory.id, payload })} />
              ))}
            </div>
          )}

          <section className="panel memory-recall-log">
            <div className="panel-head"><h2>最近召回</h2><span className="panel-meta">每一次注入都有原因和任务</span></div>
            {(snapshot.recalls ?? []).slice(0, 10).map((recall) => {
              const memory = snapshot.memories.find((item) => item.id === recall.memoryId);
              return (
                <div className="memory-recall-row" key={recall.id}>
                  <div><strong>{memory ? KIND_LABELS[memory.kind] + " · " + truncate(memory.content, 90) : "已删除记忆"}</strong><span>{recall.reason}</span></div>
                  <Link to={"/tasks/" + recall.taskId}>{formatDate(recall.createdAt)}</Link>
                </div>
              );
            })}
            {(snapshot.recalls ?? []).length === 0 && <p className="section-empty">还没有召回记录。</p>}
          </section>
        </>
      )}
    </div>
  );
}

function MemoryCreateForm({ onCreate }: { onCreate: (input: CreateMemoryRequest) => void }) {
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onCreate({
      kind: String(form.get("kind")) as MemoryKind,
      content: String(form.get("content")),
      subjectKey: String(form.get("subjectKey")),
      scope: String(form.get("scope") || "global"),
      tags: String(form.get("tags") || "").split(",").map((tag) => tag.trim()).filter(Boolean),
      confidence: String(form.get("confidence")) as NonNullable<CreateMemoryRequest["confidence"]>,
      sensitivity: String(form.get("sensitivity")) as NonNullable<CreateMemoryRequest["sensitivity"]>,
      allowRecall: form.get("allowRecall") === "on",
      source: { type: "user", id: null, label: "用户手动创建", excerpt: null }
    });
    event.currentTarget.reset();
  }
  return (
    <section className="panel">
      <div className="panel-head"><h2>新增记忆</h2><span className="panel-meta">事实、偏好和承诺必须由用户明确创建</span></div>
      <form className="memory-create-form" onSubmit={submit}>
        <div className="proactive-number-grid">
          <label>类型<select name="kind" defaultValue="fact">{Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>主题键<input name="subjectKey" placeholder="project.ember.release" required maxLength={200} /></label>
          <label>范围<input name="scope" defaultValue="global" maxLength={120} /></label>
          <label>置信度<select name="confidence" defaultValue="medium"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
          <label>敏感度<select name="sensitivity" defaultValue="normal">{Object.entries(SENSITIVITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>标签<input name="tags" placeholder="项目, 发布" maxLength={300} /></label>
        </div>
        <label className="memory-content-field">内容<textarea name="content" required maxLength={8000} rows={3} /></label>
        <div className="proactive-form-foot">
          <label className="memory-check"><input name="allowRecall" type="checkbox" defaultChecked /> 允许在相关任务中召回</label>
          <button className="primary-button" type="submit"><Brain size={15} /> 创建候选</button>
        </div>
      </form>
    </section>
  );
}

function MemorySettingsPanel({ settings, onSave }: { settings: MemorySnapshot["settings"]; onSave: (input: Partial<MemorySnapshot["settings"]>, done: () => void) => void }) {
  const [saving, setSaving] = useState(false);
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    onSave({
      autoCapture: String(form.get("autoCapture")) as MemorySnapshot["settings"]["autoCapture"],
      maxItems: Number(form.get("maxItems")),
      maxChars: Number(form.get("maxChars")),
      allowSensitive: form.get("allowSensitive") === "on"
    }, () => setSaving(false));
  }
  return (
    <section className="panel memory-settings">
      <div className="panel-head"><h2>记忆预算与自动捕获</h2><span className="panel-meta">{settings.autoCapture === "experience" ? "经历自动捕获：开启" : "仅手动创建"}</span></div>
      <form className="proactive-settings-form" onSubmit={submit}>
        <div className="proactive-number-grid">
          <label>自动捕获<select name="autoCapture" defaultValue={settings.autoCapture}><option value="off">关闭</option><option value="experience">仅任务经历</option></select></label>
          <label>最多召回条数<input name="maxItems" type="number" min="1" max="50" defaultValue={settings.maxItems} /></label>
          <label>最多注入字符<input name="maxChars" type="number" min="200" max="100000" defaultValue={settings.maxChars} /></label>
        </div>
        <div className="proactive-form-foot">
          <label className="memory-check"><input name="allowSensitive" type="checkbox" defaultChecked={settings.allowSensitive} /> 允许敏感记忆参与自动召回（机密始终排除）</label>
          <button className="primary-button" type="submit" disabled={saving}><Save size={15} /> 保存设置</button>
        </div>
      </form>
    </section>
  );
}

function MemoryCard({
  memory,
  busy,
  onAction
}: {
  memory: MemoryRecord;
  busy: boolean;
  onAction: (action: string, payload?: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(memory.content);
  const [reason, setReason] = useState("");
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onAction("correct", { content, reason });
    setEditing(false);
  }
  return (
    <article className={"panel memory-card status-" + memory.status}>
      <div className="memory-card-head">
        <div>
          <div className="suggestion-kicker">
            <span className="tag">{KIND_LABELS[memory.kind]}</span>
            <span className="tag">{STATUS_LABELS[memory.status]}</span>
            <span className="tag">{SENSITIVITY_LABELS[memory.sensitivity]}</span>
            <span className="tag">{memory.confidence}</span>
            {memory.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}
          </div>
          <strong className="memory-subject">{memory.subjectKey}</strong>
        </div>
        <span className="panel-meta">v{memory.version} · 召回 {memory.recallCount} 次</span>
      </div>
      {editing ? (
        <form className="memory-edit-form" onSubmit={submit}>
          <textarea value={content} onChange={(event) => setContent(event.target.value)} rows={4} />
          <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="纠正原因（必填）" required />
          <button className="primary-button" type="submit" disabled={busy || !reason.trim()}>保存新版本</button>
        </form>
      ) : (
        <p className="memory-content">{memory.content}</p>
      )}
      <div className="memory-meta">
        <span>来源：{memory.source.label}</span>
        <span>范围：{memory.scope}</span>
        <span>更新：{relativeTime(memory.updatedAt)}</span>
        {memory.validUntil && <span>有效至：{formatDate(memory.validUntil)}</span>}
      </div>
      <div className="suggestion-foot">
        <span className="page-meta">{memory.allowRecall ? "允许召回" : "不参与召回"}</span>
        <div className="suggestion-actions">
          {memory.status === "candidate" && <button className="primary-button" onClick={() => onAction("confirm")} disabled={busy}><Check size={15} /> 确认启用</button>}
          {memory.status !== "forgotten" && <button className="ghost-button" onClick={() => setEditing(!editing)} disabled={busy}><Pencil size={15} /> 纠正</button>}
          {memory.status !== "forgotten" && (memory.sensitivity === "normal"
            ? <button className="ghost-button" onClick={() => onAction("sensitive")} disabled={busy}><ShieldAlert size={15} /> 设为敏感</button>
            : <button className="ghost-button" onClick={() => onAction("unsensitive")} disabled={busy}><EyeOff size={15} /> 取消敏感</button>)}
          {memory.status !== "forgotten" && (
            <button className="ghost-button danger" onClick={() => { if (window.confirm("确认遗忘这条记忆？内容会替换为墓碑，并从召回中移除。")) onAction("forget"); }} disabled={busy}>
              <Trash2 size={15} /> 遗忘
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function ConflictCard({
  conflict,
  memories,
  busy,
  onResolve
}: {
  conflict: MemoryConflict;
  memories: MemoryRecord[];
  busy: boolean;
  onResolve: (input: { resolution: "keep_left" | "keep_right" | "merged"; note?: string; content?: string }) => void;
}) {
  const [merged, setMerged] = useState("");
  const left = memories.find((item) => item.id === conflict.memoryIds[0]);
  const right = memories.find((item) => item.id === conflict.memoryIds[1]);
  return (
    <div className="memory-conflict-card">
      <div className="memory-conflict-head"><strong>{conflict.subjectKey}</strong><span>{conflict.note}</span></div>
      <div className="memory-conflict-side"><span>A</span><p>{left?.content ?? "缺失"}</p><button className="ghost-button" disabled={busy} onClick={() => onResolve({ resolution: "keep_left" })}>保留 A</button></div>
      <div className="memory-conflict-side"><span>B</span><p>{right?.content ?? "缺失"}</p><button className="ghost-button" disabled={busy} onClick={() => onResolve({ resolution: "keep_right" })}>保留 B</button></div>
      <div className="memory-merge-row">
        <input value={merged} onChange={(event) => setMerged(event.target.value)} placeholder="合并后的内容" />
        <button className="primary-button" disabled={busy || !merged.trim()} onClick={() => onResolve({ resolution: "merged", content: merged, note: "用户合并冲突" })}>合并</button>
      </div>
    </div>
  );
}

function actionNotice(action: string): string {
  if (action === "confirm") return "记忆已启用。";
  if (action === "forget") return "记忆已遗忘并从召回中移除。";
  if (action === "correct") return "已创建记忆新版本。";
  if (action === "sensitive") return "已标记为敏感并停止自动召回。";
  if (action === "unsensitive") return "已恢复普通敏感度。";
  return "记忆冲突已解决。";
}

function truncate(value: string, length: number): string {
  return value.length > length ? value.slice(0, length) + "…" : value;
}
