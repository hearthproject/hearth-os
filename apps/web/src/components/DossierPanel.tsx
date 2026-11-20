import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Loader2, RefreshCw, RotateCcw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { relativeTime } from "../lib/format.ts";
import type { DossierSectionsView } from "../lib/types.ts";

const SECTION_LABELS: Array<[keyof DossierSectionsView, string]> = [
  ["overview", "概览"],
  ["stack", "技术栈"],
  ["commands", "命令"],
  ["conventions", "约定"],
  ["decisions", "最近决策与结果"],
  ["openTasks", "未完成任务"],
  ["pitfalls", "坑与失败"],
  ["evidence", "证据入口"]
];

export function DossierPanel() {
  const [tab, setTab] = useState<"dossier" | "workstyle">("dossier");

  return (
    <section className="dossier-panel">
      <div className="dossier-tabs" role="tablist" aria-label="档案视图">
        <button type="button" className={tab === "dossier" ? "active" : ""} onClick={() => setTab("dossier")}>项目档案</button>
        <button type="button" className={tab === "workstyle" ? "active" : ""} onClick={() => setTab("workstyle")}>我的工作方式</button>
      </div>
      {tab === "dossier" ? <ProjectDossier /> : <WorkstyleEditor />}
    </section>
  );
}

function ProjectDossier() {
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const [projectId, setProjectId] = useState("");
  const selected = projectId || projects.data?.projects[0]?.id || "";
  const dossier = useQuery({
    queryKey: ["dossier", selected],
    queryFn: () => api.projectDossier(selected),
    enabled: Boolean(selected)
  });
  const queryClient = useQueryClient();
  const compile = useMutation({
    mutationFn: () => api.compileProjectDossier(selected),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["dossier", selected] })
  });

  useEffect(() => {
    if (!projectId && projects.data?.projects[0]) setProjectId(projects.data.projects[0].id);
  }, [projectId, projects.data]);

  return (
    <div className="dossier-body">
      {(projects.data?.projects.length ?? 0) > 0 && (
        <div className="dossier-toolbar">
          <label>
            <FolderOpen size={15} />
            <select value={selected} onChange={(event) => setProjectId(event.target.value)} disabled={!projects.data?.projects.length}>
              {(projects.data?.projects ?? []).map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
          {selected && (
            <button type="button" className="button" onClick={() => compile.mutate()} disabled={compile.isPending}>
              {compile.isPending ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />} 重新编译
            </button>
          )}
        </div>
      )}
      {!projects.data?.projects.length && <p className="empty-state">还没有注册项目。在左侧边栏点击“新建项目”，添加一个本地文件夹。</p>}
      {compile.error && <p className="form-error">{compile.error.message}</p>}
      {dossier.data?.dossier ? (
        <>
          <p className="dossier-meta">
            编译于 {relativeTime(dossier.data.dossier.generatedAt)} · {dossier.data.dossier.projectPath}
          </p>
          <div className="dossier-sections">
            {SECTION_LABELS.map(([key, label]) => {
              const items = dossier.data!.dossier!.sections[key];
              return (
                <section className="dossier-section" key={key}>
                  <h3>{label}</h3>
                  {items.length > 0
                    ? <ul>{items.map((item, index) => <li key={`${key}-${index}`}>{item}</li>)}</ul>
                    : <p className="form-hint">（暂无）</p>}
                </section>
              );
            })}
          </div>
        </>
      ) : selected && !dossier.isLoading ? (
        <div className="dossier-empty">
          <p>这个项目还没有档案。点“重新编译”会读取项目结构、任务记录和约定文件，生成第一份档案。</p>
          <button type="button" className="button primary" onClick={() => compile.mutate()}>生成档案</button>
        </div>
      ) : dossier.isLoading ? <p className="form-hint"><Loader2 className="spin" size={15} /> 正在读取档案…</p> : null}
    </div>
  );
}

function WorkstyleEditor() {
  const query = useQuery({ queryKey: ["workstyle"], queryFn: api.workstyle });
  const [draft, setDraft] = useState("");
  const queryClient = useQueryClient();
  useEffect(() => {
    if (query.data) setDraft(query.data.workstyle.content);
  }, [query.data]);

  const save = useMutation({
    mutationFn: () => api.updateWorkstyle(draft),
    onSuccess: (data) => {
      setDraft(data.workstyle.content);
      void queryClient.invalidateQueries({ queryKey: ["workstyle"] });
    }
  });
  const reset = useMutation({
    mutationFn: api.resetWorkstyle,
    onSuccess: (data) => {
      setDraft(data.workstyle.content);
      void queryClient.invalidateQueries({ queryKey: ["workstyle"] });
    }
  });

  return (
    <div className="dossier-body">
      <p className="dossier-meta">这里的偏好会作为 coding 任务的工作方式提示；目标、权限和仓库约定仍然优先。</p>
      <textarea
        className="dossier-editor"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        spellCheck={false}
        rows={22}
      />
      <div className="settings-actions">
        <button type="button" className="button primary" onClick={() => save.mutate()} disabled={save.isPending || !draft.trim()}>
          {save.isPending ? <Loader2 className="spin" size={15} /> : <Save size={15} />} 保存
        </button>
        <button type="button" className="button" onClick={() => reset.mutate()} disabled={reset.isPending}>
          {reset.isPending ? <Loader2 className="spin" size={15} /> : <RotateCcw size={15} />} 恢复默认
        </button>
      </div>
      {save.error && <p className="form-error">{save.error.message}</p>}
      {reset.error && <p className="form-error">{reset.error.message}</p>}
      {query.data?.workstyle.isDefault && <p className="form-hint">当前是默认内容；保存后会写入本机数据目录。</p>}
    </div>
  );
}
