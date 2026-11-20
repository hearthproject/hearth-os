import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Brain,
  CheckSquare,
  ChevronRight,
  FileText,
  Folder,
  FolderKanban,
  FolderOpen,
  Library,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type { LibraryNode, LibrarySearchHit, LibraryTreeNode } from "@hearth/core";
import { api } from "../lib/api.ts";

const KIND_LABELS: Record<LibraryNode["kind"], string> = {
  root: "分类",
  memory: "记忆",
  task: "任务",
  source: "资料",
  artifact: "成果",
  file: "文件",
  folder: "文件夹",
  skill: "技能",
  project: "项目"
};

export function LibraryPage() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);

  const statusQuery = useQuery({ queryKey: ["library-status"], queryFn: api.libraryStatus, refetchInterval: 30_000 });
  const treeQuery = useQuery({ queryKey: ["library-tree"], queryFn: () => api.libraryTree(2) });
  const detailsQuery = useQuery({
    queryKey: ["library-node", selectedId],
    queryFn: () => api.libraryNode(selectedId!),
    enabled: Boolean(selectedId)
  });
  const trashQuery = useQuery({ queryKey: ["library-trash"], queryFn: api.libraryTrash, enabled: trashOpen });

  const searchMutation = useMutation({
    mutationFn: (value: string) => api.librarySearch(value),
    onSuccess: (_result, value) => setSubmittedQuery(value)
  });

  const refreshMutation = useMutation({
    mutationFn: api.libraryReindex,
    onSuccess: () => invalidateLibrary(queryClient)
  });

  const deleteMutation = useMutation({
    mutationFn: (node: LibraryNode) => api.libraryDeleteNode(node.id),
    onSuccess: () => {
      setSelectedId(null);
      invalidateLibrary(queryClient);
    }
  });

  const addRootMutation = useMutation({
    mutationFn: api.libraryAddRoot,
    onSuccess: () => invalidateLibrary(queryClient)
  });

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const clean = query.trim();
    if (!clean) {
      setSubmittedQuery("");
      searchMutation.reset();
      return;
    }
    searchMutation.mutate(clean);
  }

  function clearSearch() {
    setQuery("");
    setSubmittedQuery("");
    searchMutation.reset();
  }

  function addFolder() {
    const path = window.prompt("输入要加入资料库的文件夹路径：");
    if (path?.trim()) addRootMutation.mutate(path.trim());
  }

  function removeNode(node: LibraryNode) {
    const message = node.kind === "memory"
      ? "移到回收站后，Hearth 将不再参考这条记忆。30 天内可以恢复，确定吗？"
      : "移到回收站？原文件不会被删除，30 天内可以恢复。";
    if (window.confirm(message)) deleteMutation.mutate(node);
  }

  const results = searchMutation.data?.hits ?? null;
  const details = detailsQuery.data;
  const rootNodes = treeQuery.data?.nodes ?? [];
  const total = statusQuery.data?.nodeCount ?? 0;

  return (
    <div className="page workbench-page library-page">
      <div className="page-head library-page-head">
        <div>
          <h1>资料库</h1>
          <p className="page-meta">你的文件、记忆、任务资料和技能，都在一个地方。</p>
        </div>
        <div className="library-head-actions">
          <span className="library-total">{total > 0 ? `${total} 份资料` : "还没有资料"}</span>
          <button className="ghost-button" onClick={addFolder} disabled={addRootMutation.isPending}>
            {addRootMutation.isPending ? <Loader2 size={15} className="spin" /> : <Plus size={15} />} 添加文件夹
          </button>
          <button className="ghost-button" onClick={() => refreshMutation.mutate()} disabled={refreshMutation.isPending}>
            {refreshMutation.isPending ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} 刷新资料
          </button>
        </div>
      </div>

      <form className="library-search" onSubmit={submitSearch}>
        <label>
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜文件、记忆、任务或技能"
          />
        </label>
        <button className="primary-button" type="submit" disabled={searchMutation.isPending}>
          {searchMutation.isPending ? <Loader2 size={15} className="spin" /> : <Search size={15} />} 搜索
        </button>
        {submittedQuery && <button className="ghost-button" type="button" onClick={clearSearch}><X size={15} /> 清除</button>}
      </form>

      {addRootMutation.isError && <p className="form-error">{addRootMutation.error.message}</p>}
      {deleteMutation.isError && <p className="form-error">{deleteMutation.error.message}</p>}
      {refreshMutation.isError && <p className="form-error">{refreshMutation.error.message}</p>}

      <div className="library-layout">
        <aside className="library-pane library-browser">
          <div className="library-pane-head">
            <div>
              <strong>{trashOpen ? "回收站" : submittedQuery ? "搜索结果" : "全部资料"}</strong>
              <span>{trashOpen ? "保留 30 天" : submittedQuery ? `${results?.length ?? 0} 条结果` : "按分类查看"}</span>
            </div>
            <button className={`icon-button${trashOpen ? " active" : ""}`} onClick={() => setTrashOpen((open) => !open)} title="回收站">
              <Archive size={16} />
            </button>
          </div>

          {trashOpen ? (
            <TrashList
              loading={trashQuery.isLoading}
              error={trashQuery.error}
              entries={trashQuery.data?.entries ?? []}
              onChanged={() => invalidateLibrary(queryClient)}
            />
          ) : submittedQuery ? (
            <SearchList
              query={submittedQuery}
              pending={searchMutation.isPending}
              error={searchMutation.error}
              hits={results}
              selectedId={selectedId}
              onSelect={(hit) => setSelectedId(hit.node.id)}
            />
          ) : treeQuery.isLoading ? (
            <p className="section-empty">正在打开资料库…</p>
          ) : treeQuery.isError ? (
            <p className="form-error">{treeQuery.error.message}</p>
          ) : rootNodes.length === 0 ? (
            <div className="library-empty-small"><FolderOpen size={22} /><span>点“添加文件夹”放入第一份资料。</span></div>
          ) : (
            <div className="library-tree">
              {rootNodes.map((node) => (
                <TreeNodeRow
                  key={node.id}
                  node={node}
                  depth={0}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              ))}
            </div>
          )}
        </aside>

        <section className="library-pane library-preview">
          {detailsQuery.isLoading ? (
            <div className="library-centered"><Loader2 size={20} className="spin" /><span>正在打开…</span></div>
          ) : detailsQuery.isError ? (
            <p className="form-error">{detailsQuery.error.message}</p>
          ) : !details ? (
            <div className="library-centered">
              <Library size={34} />
              <strong>从左边选一份资料</strong>
              <span>可以直接看内容，也可以按关键词搜索。</span>
            </div>
          ) : (
            <NodePreview
              node={details.node}
              content={details.document?.content ?? null}
              children={details.children}
              deleting={deleteMutation.isPending}
              onSelect={setSelectedId}
              onDelete={() => removeNode(details.node)}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function TreeNodeRow({
  node,
  depth,
  selectedId,
  onSelect
}: {
  node: LibraryTreeNode;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(depth === 0 && node.childCount > 0);
  const childrenQuery = useQuery({
    queryKey: ["library-tree", node.id],
    queryFn: () => api.libraryTree(2, node.id),
    enabled: open && !node.children && node.childCount > 0
  });
  const children = node.children?.map((child) => child as LibraryTreeNode) ?? childrenQuery.data?.nodes ?? [];
  const expandable = node.childCount > 0 || children.length > 0;
  const Icon = iconFor(node.kind);

  return (
    <div className="library-tree-group">
      <button
        className={`library-tree-row${selectedId === node.id ? " selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          onSelect(node.id);
          if (expandable) setOpen((value) => !value);
        }}
      >
        {expandable ? <ChevronRight size={14} className={`library-chevron${open ? " open" : ""}`} /> : <span className="library-chevron-space" />}
        <Icon size={16} />
        <span className="library-tree-title">{node.title}</span>
        {node.childCount > 0 && <span className="library-tree-count">{node.childCount}</span>}
      </button>
      {open && childrenQuery.isLoading && <p className="library-tree-loading">正在打开…</p>}
      {open && children.map((child) => (
        <TreeNodeRow key={child.id} node={child} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} />
      ))}
    </div>
  );
}

function SearchList({
  query,
  pending,
  error,
  hits,
  selectedId,
  onSelect
}: {
  query: string;
  pending: boolean;
  error: Error | null;
  hits: LibrarySearchHit[] | null;
  selectedId: string | null;
  onSelect: (hit: LibrarySearchHit) => void;
}) {
  if (pending) return <div className="library-centered small"><Loader2 size={18} className="spin" /><span>正在搜索“{query}”…</span></div>;
  if (error) return <p className="form-error">{error.message}</p>;
  if (!hits || hits.length === 0) return <div className="library-empty-small"><Search size={22} /><span>没有找到，换个说法试试。</span></div>;
  return (
    <div className="library-search-results">
      {hits.map((hit) => (
        <button
          key={hit.node.id}
          className={`library-result${selectedId === hit.node.id ? " selected" : ""}`}
          onClick={() => onSelect(hit)}
        >
          <span className="library-result-kind">{KIND_LABELS[hit.node.kind]}</span>
          <strong>{hit.node.title}</strong>
          <span>{hit.snippet}</span>
        </button>
      ))}
    </div>
  );
}

function TrashList({
  loading,
  error,
  entries,
  onChanged
}: {
  loading: boolean;
  error: Error | null;
  entries: Awaited<ReturnType<typeof api.libraryTrash>>["entries"];
  onChanged: () => void;
}) {
  const restore = useMutation({
    mutationFn: api.libraryRestoreTrash,
    onSuccess: onChanged
  });
  const purge = useMutation({
    mutationFn: api.libraryPurgeTrash,
    onSuccess: onChanged
  });

  if (loading) return <p className="section-empty">正在打开回收站…</p>;
  if (error) return <p className="form-error">{error.message}</p>;
  if (entries.length === 0) return <div className="library-empty-small"><Archive size={22} /><span>回收站是空的。</span></div>;
  return (
    <div className="library-trash-list">
      {entries.map((entry) => (
        <div className="library-trash-row" key={entry.id}>
          <div>
            <strong>{entry.title}</strong>
            <span>{new Date(entry.deletedAt).toLocaleDateString("zh-CN")} 删除</span>
          </div>
          <div className="library-trash-actions">
            <button className="icon-button" title="恢复" onClick={() => restore.mutate(entry.id)} disabled={restore.isPending}>
              <RotateCcw size={15} />
            </button>
            <button className="icon-button danger" title="永久删除" onClick={() => {
              if (window.confirm("永久删除后无法恢复，确定吗？")) purge.mutate(entry.id);
            }} disabled={purge.isPending}>
              <Trash2 size={15} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function NodePreview({
  node,
  content,
  children,
  deleting,
  onSelect,
  onDelete
}: {
  node: LibraryNode;
  content: string | null;
  children: LibraryNode[];
  deleting: boolean;
  onSelect: (id: string) => void;
  onDelete: () => void;
}) {
  const Icon = iconFor(node.kind);
  return (
    <div className="library-document">
      <div className="library-document-head">
        <div className="library-document-title">
          <span className="library-document-icon"><Icon size={18} /></span>
          <div>
            <span>{KIND_LABELS[node.kind]}</span>
            <h2>{node.title}</h2>
          </div>
        </div>
        <div className="library-document-actions">
          <span className="library-path">{node.path}</span>
          {node.kind !== "root" && (
            <button className="ghost-button danger" onClick={onDelete} disabled={deleting}>
              {deleting ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />} 移入回收站
            </button>
          )}
        </div>
      </div>

      {children.length > 0 && (
        <div className="library-child-grid">
          {children.map((child) => (
            <button key={child.id} className="library-child-card" onClick={() => onSelect(child.id)}>
              {iconElement(child.kind)}
              <span>{child.title}</span>
            </button>
          ))}
        </div>
      )}

      {content ? (
        <article className="library-document-body">{content}</article>
      ) : children.length === 0 ? (
        <div className="library-centered small"><FileText size={24} /><span>这份资料暂时没有可预览的文字。</span></div>
      ) : null}
    </div>
  );
}

function iconElement(kind: LibraryNode["kind"]): ReactNode {
  const Icon = iconFor(kind);
  return <Icon size={17} />;
}

function iconFor(kind: LibraryNode["kind"]) {
  return ({
    root: FolderOpen,
    memory: Brain,
    task: CheckSquare,
    source: Library,
    artifact: FileText,
    file: FileText,
    folder: Folder,
    skill: Sparkles,
    project: FolderKanban
  } as const)[kind];
}

function invalidateLibrary(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ["library-status"] });
  void queryClient.invalidateQueries({ queryKey: ["library-tree"] });
  void queryClient.invalidateQueries({ queryKey: ["library-trash"] });
  void queryClient.invalidateQueries({ queryKey: ["library-node"] });
  void queryClient.invalidateQueries({ queryKey: ["memory"] });
}
