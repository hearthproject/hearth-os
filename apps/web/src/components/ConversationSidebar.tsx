import { useState, type MouseEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { Folder, FolderPlus, Loader2, Plus, Trash2, TriangleAlert } from "lucide-react";
import { api, ApiError } from "../lib/api.ts";
import { useChatSelection, requestChat } from "../lib/chat-selection.ts";
import { isActive, needsAttention } from "../lib/format.ts";
import type { ConversationListItem, LocalProjectView, TaskListItem } from "../lib/types.ts";
import { ProjectDialog } from "./ProjectDialog.tsx";

export function ConversationSidebar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const queryClient = useQueryClient();
  const selection = useChatSelection();
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const conversationsQuery = useQuery({ queryKey: ["conversations"], queryFn: api.conversations, refetchInterval: 15_000 });
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: api.projects, refetchInterval: 30_000 });
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 8_000 });

  const conversations = conversationsQuery.data?.conversations ?? [];
  const projects = projectsQuery.data?.projects ?? [];
  const tasks = tasksQuery.data?.tasks ?? [];
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const tasksByConversation = new Map<string, TaskListItem[]>();
  for (const task of tasks) {
    if (!task.conversationId) continue;
    const list = tasksByConversation.get(task.conversationId) ?? [];
    list.push(task);
    tasksByConversation.set(task.conversationId, list);
  }
  const projectGroups = projects.map((project) => ({
    project,
    conversations: conversations.filter((conversation) => conversation.projectId === project.id)
  }));
  const standalone = conversations.filter((conversation) => !conversation.projectId || !projectsById.has(conversation.projectId));
  const canSwitch = !selection.busy;

  function openChat(conversationId: string | null, projectId: string | null = null) {
    if (selection.busy) return;
    if (conversationId === selection.conversationId && projectId === selection.pendingProjectId && pathname === "/") return;
    requestChat(conversationId, projectId);
    if (pathname !== "/") navigate("/");
  }

  async function removeConversation(event: MouseEvent, conversation: ConversationListItem) {
    event.stopPropagation();
    if (selection.busy || busyId) return;
    if (!window.confirm(`删除对话「${conversation.title}」？`)) return;
    setBusyId(conversation.id);
    setError(null);
    try {
      try {
        await api.deleteConversation(conversation.id);
      } catch (caught) {
        if (!(caught instanceof ApiError) || caught.code !== "TASK_RUNNING") throw caught;
        if (!window.confirm("这个对话里还有任务正在运行。取消运行中的任务并删除整个对话吗？")) return;
        await api.deleteConversation(conversation.id, true);
      }
      if (selection.conversationId === conversation.id) openChat(null);
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除对话失败");
    } finally {
      setBusyId(null);
    }
  }

  async function removeProject(event: MouseEvent, project: LocalProjectView) {
    event.stopPropagation();
    if (selection.busy || busyId) return;
    if (!window.confirm(`删除项目「${project.name}」？对话会保留为独立对话，本地文件不会被删除。`)) return;
    setBusyId(project.id);
    setError(null);
    try {
      await api.deleteProject(project.id);
      if (selection.pendingProjectId === project.id) openChat(null);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除项目失败");
    } finally {
      setBusyId(null);
    }
  }

  function renderConversation(conversation: ConversationListItem) {
    return (
      <ConversationItem
        key={conversation.id}
        conversation={conversation}
        tasks={tasksByConversation.get(conversation.id) ?? []}
        active={conversation.id === selection.conversationId}
        disabled={!canSwitch}
        deleting={busyId === conversation.id}
        onSelect={() => openChat(conversation.id)}
        onDelete={(event) => void removeConversation(event, conversation)}
      />
    );
  }

  return (
    <section className="sidebar-conversations" aria-label="对话">
      <button className="new-chat-button" onClick={() => openChat(null)} disabled={!canSwitch}>
        <Plus size={15} /> 新对话
      </button>
      <div className="conversation-list">
        {conversations.length === 0 && projects.length === 0 && <p className="rail-empty">还没有对话</p>}
        {projectGroups.length > 0 && <p className="rail-group-title">项目</p>}
        {projectGroups.map(({ project, conversations: projectConversations }) => (
          <div className="rail-project" key={project.id}>
            <div className={`rail-project-head ${selection.pendingProjectId === project.id ? "active" : ""}`} title={project.path}>
              <button
                className="rail-project-name"
                onClick={() => openChat(null, project.id)}
                disabled={!canSwitch || !project.available}
              >
                <Folder size={13} />
                <span>{project.name}</span>
              </button>
              <button
                className="rail-project-new"
                onClick={() => openChat(null, project.id)}
                disabled={!canSwitch || !project.available}
                title="在此项目中新建对话"
                aria-label={`在 ${project.name} 中新建对话`}
              >
                <Plus size={12} />
              </button>
              <button
                className="rail-project-delete"
                onClick={(event) => void removeProject(event, project)}
                disabled={!canSwitch || busyId === project.id}
                title="删除项目"
                aria-label={`删除项目 ${project.name}`}
              >
                <Trash2 size={12} />
              </button>
            </div>
            {project.kind === "git" && (project.currentBranch || project.defaultBranch) && (
              <span className="rail-project-branch">{project.currentBranch ?? project.defaultBranch}</span>
            )}
            {!project.available && <span className="rail-project-error">{project.error ?? "项目不可用"}</span>}
            {projectConversations.map(renderConversation)}
          </div>
        ))}
        {(standalone.length > 0 || projects.length > 0) && <p className="rail-group-title">最近</p>}
        {standalone.map(renderConversation)}
      </div>
      {error && <p className="sidebar-error" role="alert">{error}</p>}
      <button className="rail-footer-button" onClick={() => setProjectDialogOpen(true)} disabled={!canSwitch}>
        <FolderPlus size={14} /> 新建项目
      </button>
      {projectDialogOpen && (
        <ProjectDialog
          onClose={() => setProjectDialogOpen(false)}
          onCreated={(project) => {
            setProjectDialogOpen(false);
            void queryClient.invalidateQueries({ queryKey: ["projects"] });
            openChat(null, project.id);
          }}
        />
      )}
    </section>
  );
}

function ConversationItem({
  conversation,
  tasks,
  active,
  disabled,
  deleting,
  onSelect,
  onDelete
}: {
  conversation: ConversationListItem;
  tasks: TaskListItem[];
  active: boolean;
  disabled: boolean;
  deleting: boolean;
  onSelect: () => void;
  onDelete: (event: MouseEvent) => void;
}) {
  const open = tasks.filter((task) => !task.archivedAt);
  const running = open.filter((task) => isActive(task.status)).length;
  const attention = open.filter((task) => needsAttention(task.status)).length;
  return (
    <div className={`conversation-item ${active ? "active" : ""}`}>
      <div className="conversation-row">
        <button className="conversation-select" onClick={onSelect} disabled={disabled} title={conversation.preview || conversation.title}>
          <span className="conversation-title">{conversation.title}</span>
          {running > 0 && <span className="conv-inline running"><Loader2 size={10} className="spin" />运行中</span>}
          {attention > 0 && running === 0 && <span className="conv-inline attention"><TriangleAlert size={10} />待处理</span>}
        </button>
        <button className="conversation-delete" onClick={onDelete} disabled={disabled} aria-label="删除对话">
          {deleting ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}
        </button>
      </div>
    </div>
  );
}
