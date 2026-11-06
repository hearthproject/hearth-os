import type { ReactNode } from "react";

export function ProSection({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel pro-section">
      <div className="panel-head">
        <h2>{title}</h2>
        {meta && <span className="panel-meta">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

export function EmptyLine({ text }: { text: string }) {
  return <p className="section-empty">{text}</p>;
}
