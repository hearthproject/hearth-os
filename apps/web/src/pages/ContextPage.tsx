import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { api } from "../lib/api.ts";

export function ContextPage() {
  const memory = useQuery({ queryKey: ["memory"], queryFn: api.memory });
  const entries = memory.data?.memories.filter(entry => entry.status === "active");
  return <div className="page workbench-page">
    <header className="page-head">
      <h1>Context</h1>
      <button className="ghost-button" type="button" disabled title="多账号共享尚未开放">
        <Users size={15} aria-hidden="true" /> 多账号共享
      </button>
    </header>
    <section>
      <h2>已生效的记忆</h2>
      {memory.isLoading && <p role="status">正在读取记忆…</p>}
      {memory.error && <p role="alert">{memory.error.message}</p>}
      {entries?.length === 0 && <p className="page-meta">当前没有已生效的记忆。</p>}
      {entries?.map(entry => <p key={entry.id} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{entry.content}</p>)}
    </section>
  </div>;
}
