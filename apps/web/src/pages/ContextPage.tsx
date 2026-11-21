import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Users } from "lucide-react";
import "../styles/context.css";
import { useState } from "react";
import { strToU8, zipSync } from "fflate";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.ts";
import type { MemorySnapshot } from "../lib/types.ts";

type Entry = MemorySnapshot["memories"][number];

function title(entry: Entry) {
  return entry.content.match(/^任务「(.+?)」/)?.[1] || entry.source.label || entry.subjectKey;
}

// Quote explicit fields from one record so unrelated tasks never become one handoff.
function summary(entry: Entry) {
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

export function ContextPage() {
  const memory = useQuery({ queryKey: ["memory"], queryFn: api.memory });
  const entries = (memory.data?.memories ?? []).filter(entry => entry.status === "active")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const [sourceId, setSourceId] = useState("");
  const [params, setParams] = useSearchParams();
  const sharing = params.get("view") === "sharing";
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState("");
  const [includeSummary, setIncludeSummary] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const source = entries.find(entry => entry.id === sourceId) ?? entries[0];
  const rows = source ? summary(source) : [];
  const needle = search.trim().toLowerCase();
  const visible = entries.filter(entry => (title(entry) + " " + entry.content).toLowerCase().includes(needle));
  const originals = entries.filter(entry => selected.includes(entry.id));

  function showSource() {
    if (!source) return;
    setParams({ view: "sharing" });
    setSearch("");
    setExpanded(source.id);
    requestAnimationFrame(() => document.getElementById("memory-" + source.id)?.focus());
  }

  function download() {
    const sections = ["# Context 交接"];
    if (includeSummary && source) sections.push("## 接手摘要", ...rows.map(row =>
      "- " + row.label + "：" + (row.quote || "原文未明确记录")), "摘要来源：" + title(source) + " · " + source.id);
    for (const entry of originals) sections.push("## " + title(entry), "记忆 ID：" + entry.id, entry.content);
    const files = { "交接说明.md": strToU8(sections.join("\n\n")) };
    const memories = originals.map(({ id, content, updatedAt }) => ({ id, content, updatedAt }));
    const archive = zipSync(memories.length ? {
      ...files, "memories.json": strToU8(JSON.stringify({ version: 1, memories }, null, 2))
    } : files);
    const url = URL.createObjectURL(new Blob([new Uint8Array(archive).buffer], { type: "application/zip" }));
    const link = document.createElement("a");
    link.href = url;
    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
    link.download = "hearth-context-" + date + ".zip";
    link.click();
    setNotice("压缩包已生成，可发送给接手人。");
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="page workbench-page context-page">
    <header className="page-head"><h1>{sharing ? "多账号共享" : "Context"}</h1>
      {sharing ? <Link className="ghost-button" to="/context">返回接手摘要</Link>
        : <Link className="ghost-button" to="?view=sharing"><Users size={15} /> 多账号共享</Link>}
    </header>
    {memory.isLoading && <p role="status">正在读取记忆…</p>}
    {memory.error && <p role="alert">{memory.error.message}</p>}
    {memory.data && !source && <p>当前没有已生效的记忆。</p>}
    {source && <>
      {!sharing ? <section><h2>接手摘要</h2>
        <label className="context-field">摘要来源 <select value={source.id} onChange={event => setSourceId(event.target.value)}>
          {entries.map(entry => <option key={entry.id} value={entry.id}>{title(entry)}</option>)}
        </select></label>
        <dl>{rows.map(row => <div key={row.label}><dt><strong>{row.label}</strong></dt>
          <dd>{row.quote ?? "原文未明确记录"} {row.quote && <button className="ghost-button" onClick={showSource}>查看原文</button>}</dd></div>)}</dl>
      </section> : <>
      <section><h2>全部记忆 · {entries.length} 条</h2>
        <label className="context-field">搜索记忆 <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="标题或正文" /></label>
        {visible.length === 0 && <p>没有匹配的记忆。</p>}
        {visible.map(entry => <article key={entry.id}>
          <button id={"memory-" + entry.id} className="ghost-button" aria-expanded={expanded === entry.id}
            onClick={() => setExpanded(expanded === entry.id ? "" : entry.id)}><ChevronRight size={16} aria-hidden="true" />{title(entry)}</button>
          <label><input type="checkbox" aria-label={"交接原文：" + title(entry)} checked={selected.includes(entry.id)}
            onChange={event => setSelected(event.target.checked ? [...selected, entry.id] : selected.filter(id => id !== entry.id))} /> 加入交接</label>
          <div className="context-reveal" data-open={expanded === entry.id} aria-hidden={expanded !== entry.id}>
            <div><p>{entry.content}</p></div>
          </div>
        </article>)}
      </section>
      <section><h2>交接范围</h2>
        <label><input type="checkbox" checked={includeSummary} onChange={event => setIncludeSummary(event.target.checked)} /> 包含接手摘要</label>
        <p>{[includeSummary && "接手摘要", originals.length > 0 && originals.length + " 条记忆原文"].filter(Boolean).join(" + ") || "尚未选择交接内容"}</p>
        <button className="primary-button" disabled={!includeSummary && !originals.length} onClick={download}>分享记忆压缩包</button>
        {notice && <p role="status">{notice}</p>}
      </section>
      </>}
    </>}
  </div>;
}
