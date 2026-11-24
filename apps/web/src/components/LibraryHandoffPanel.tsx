import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Download, Loader2, PackagePlus, Search, Users } from "lucide-react";
import { strToU8, zipSync } from "fflate";
import type { LibraryTreeNode } from "@hearth/core";
import { api } from "../lib/api.ts";
import type { MemorySnapshot } from "../lib/types.ts";
import "../styles/handoff.css";

type Entry = MemorySnapshot["memories"][number];

function entryTitle(entry: Entry): string {
  return entry.content.match(/^任务「(.+?)」/)?.[1] || entry.source.label || entry.subjectKey;
}

function summaryRows(entry: Entry) {
  const fields = [
    ["任务目标", /(?:目标|项目目标)[：:]\s*([^\n。]+)/],
    ["最近决定或结果", /(?:决定|决策|结果)[：:]\s*([^\n。]+)/],
    ["下一步", /(?:下一步(?:计划)?|待办事项|后续计划)[：:]\s*([^\n。]+)/]
  ] as const;
  return fields.map(([label, pattern]) => {
    const quote = pattern.exec(entry.content)?.[1]?.trim();
    return { label, quote: quote && (quote.length > 140 ? quote.slice(0, 140) + "…" : quote) };
  });
}

function flattenMemoryNodes(nodes: LibraryTreeNode[]): LibraryTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenMemoryNodes(node.children ?? [])]);
}

function handleSummary(entry: Entry): string {
  return summaryRows(entry).map((row) => `${row.label}：${row.quote ?? "原文未明确记录"}`).join("；");
}

export function LibraryHandoffPanel({ onSaved }: { onSaved: (nodeId: string) => void }) {
  const queryClient = useQueryClient();
  const memoryQuery = useQuery({ queryKey: ["memory"], queryFn: api.memory });
  const treeQuery = useQuery({
    queryKey: ["library-tree", "handoff"],
    queryFn: async () => {
      const roots = await api.libraryTree(2);
      const memoryRoot = roots.nodes.find((node) => node.ref === "hearth://root/memory");
      if (!memoryRoot) return { nodes: [] as LibraryTreeNode[] };
      return api.libraryTree(4, memoryRoot.id);
    }
  });
  const entries = useMemo(
    () => (memoryQuery.data?.memories ?? []).filter((entry) => entry.status === "active").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [memoryQuery.data]
  );
  const activeById = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const memoryNodes = useMemo(
    () => flattenMemoryNodes(treeQuery.data?.nodes ?? []).filter((node) => {
      const memoryId = typeof node.metadata.memoryId === "string" ? node.metadata.memoryId : null;
      return node.kind === "memory" && memoryId !== null && activeById.has(memoryId);
    }),
    [treeQuery.data, activeById]
  );

  const [sourceId, setSourceId] = useState("");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState("");
  const [includeSummary, setIncludeSummary] = useState(true);

  const source = entries.find((entry) => entry.id === sourceId) ?? entries[0];
  const rows = source ? summaryRows(source) : [];
  const needle = filter.trim().toLowerCase();
  const visibleNodes = needle
    ? memoryNodes.filter((node) => {
      const entry = activeById.get(String(node.metadata.memoryId));
      return `${node.title} ${entry?.content ?? ""}`.toLowerCase().includes(needle);
    })
    : memoryNodes;
  const originals = entries.filter((entry) => selected.includes(entry.id));

  const saveMutation = useMutation({
    mutationFn: api.librarySaveHandoff,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["library-status"] });
      void queryClient.invalidateQueries({ queryKey: ["library-tree"] });
      onSaved(result.node.id);
    }
  });

  function toggleMemory(memoryId: string) {
    setSelected((current) => current.includes(memoryId) ? current.filter((id) => id !== memoryId) : [...current, memoryId]);
  }

  function markdown(): string {
    const sections = ["# 交接说明"];
    if (includeSummary && source) {
      sections.push("## 接手摘要", ...rows.map((row) => `- ${row.label}：${row.quote ?? "原文未明确记录"}`), `摘要来源：${entryTitle(source)} · ${source.id}`);
    }
    for (const entry of originals) sections.push(`## ${entryTitle(entry)}`, `记忆 ID：${entry.id}`, entry.content);
    return sections.join("\n\n");
  }

  function archive(): Uint8Array {
    const memories = originals.map(({ id, content, updatedAt }) => ({ id, content, updatedAt }));
    return zipSync(memories.length > 0
      ? { "交接说明.md": strToU8(markdown()), "memories.json": strToU8(JSON.stringify({ version: 1, memories }, null, 2)) }
      : { "交接说明.md": strToU8(markdown()) });
  }

  function archiveName(): string {
    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
    return `hearth-handoff-${date}.zip`;
  }

  function download() {
    const bytes = archive();
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: "application/zip" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = archiveName();
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function saveToLibrary() {
    saveMutation.mutate({
      title: `交接 · ${source ? entryTitle(source) : "记忆"}`.slice(0, 80),
      markdown: markdown(),
      memories: originals.map(({ id, content, updatedAt }) => ({ id, content, updatedAt })),
      zipBase64: toBase64(archive()),
      archiveName: archiveName()
    });
  }

  const empty = !memoryQuery.isLoading && entries.length === 0;

  return <div className="library-handoff">
    <div className="library-pane library-browser library-handoff-list">
      <div className="library-pane-head">
        <div>
          <strong>记忆</strong>
          <span>{selected.length > 0 ? `已选 ${selected.length} 条原文` : "勾选要交接的原文"}</span>
        </div>
      </div>
      <label className="library-handoff-filter">
        <Search size={14} />
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="按标题或正文筛选" />
      </label>
      <div className="library-handoff-rows">
        {memoryQuery.isLoading || treeQuery.isLoading ? <p className="library-tree-loading">正在读取记忆…</p>
          : memoryQuery.error || treeQuery.error ? <p className="form-error">{(memoryQuery.error ?? treeQuery.error)?.message}</p>
            : empty ? <div className="library-empty-small"><Users size={22} /><span>当前没有已生效的记忆，先聊几轮再来交接。</span></div>
              : visibleNodes.length === 0 ? <div className="library-empty-small"><Search size={22} /><span>没有匹配的记忆。</span></div>
                : visibleNodes.map((node) => {
                  const memoryId = String(node.metadata.memoryId);
                  const entry = activeById.get(memoryId);
                  return <label key={node.id} className="library-handoff-row">
                    <input
                      type="checkbox"
                      checked={selected.includes(memoryId)}
                      onChange={() => toggleMemory(memoryId)}
                    />
                    <span>
                      <strong>{node.title}</strong>
                      <em>{entry ? `${entry.source.label} · ${handleSummary(entry)}` : node.path}</em>
                    </span>
                  </label>;
                })}
      </div>
    </div>

    <div className="library-pane library-handoff-detail">
      {memoryQuery.isLoading ? <div className="library-centered"><Loader2 size={18} className="spin" /><span>正在读取…</span></div>
        : empty ? <div className="library-centered"><Users size={30} /><strong>还没有可交接的记忆</strong><span>任务跑完会自动生成经验记忆。</span></div>
          : <div className="library-handoff-body">
            <section>
              <h2>接手摘要</h2>
              <label className="library-handoff-field">摘要来源
                <select value={source?.id ?? ""} onChange={(event) => setSourceId(event.target.value)}>
                  {entries.map((entry) => <option key={entry.id} value={entry.id}>{entryTitle(entry)}</option>)}
                </select>
              </label>
              <dl>
                {rows.map((row) => <div key={row.label}>
                  <dt><strong>{row.label}</strong></dt>
                  <dd>
                    {row.quote ?? "原文未明确记录"}
                    {row.quote && <button className="ghost-button" onClick={() => setExpanded(expanded === source?.id ? "" : source?.id ?? "")}>
                      <ChevronRight size={14} /> {expanded === source?.id ? "收起原文" : "查看原文"}
                    </button>}
                  </dd>
                </div>)}
              </dl>
              {source && <div className="library-handoff-source" data-open={expanded === source.id}>
                <p>{source.content}</p>
              </div>}
            </section>

            <section>
              <h2>交接范围</h2>
              <label className="library-handoff-check">
                <input type="checkbox" checked={includeSummary} onChange={(event) => setIncludeSummary(event.target.checked)} /> 包含接手摘要
              </label>
              <p className="library-handoff-range">
                {[includeSummary && source && "接手摘要", originals.length > 0 && `${originals.length} 条记忆原文`].filter(Boolean).join(" + ") || "尚未选择交接内容"}
              </p>
              <div className="library-handoff-actions">
                <button className="primary-button" disabled={((!includeSummary || !source) && originals.length === 0) || saveMutation.isPending} onClick={saveToLibrary}>
                  {saveMutation.isPending ? <Loader2 size={15} className="spin" /> : <PackagePlus size={15} />} 存入资料库
                </button>
                <button className="ghost-button" disabled={(!includeSummary || !source) && originals.length === 0} onClick={download}>
                  <Download size={15} /> 仅下载压缩包
                </button>
              </div>
              <p className="library-handoff-hint">存入后会落在资料库的「资料 / 交接」目录，可以检索、预览和回收站恢复。</p>
              {saveMutation.isError && <p className="form-error">{saveMutation.error.message}</p>}
            </section>
          </div>}
    </div>
  </div>;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}