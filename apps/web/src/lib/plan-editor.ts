/**
 * Plan markdown <-> editable blocks.
 *
 * The approval dialog lets users add / remove / edit individual plan entries.
 * These helpers split a plan into stable blocks (headings, list items, prose,
 * fenced code) and stitch them back into the exact same markdown shape so the
 * edited text can be submitted through the existing approve(planMarkdown)
 * channel without touching the server contract.
 */

export type PlanBlockKind = "heading" | "item" | "text" | "code" | "blank";

export interface PlanBlock {
  id: string;
  kind: PlanBlockKind;
  /** Leading whitespace, preserved on serialize. */
  indent: string;
  /** Markdown marker: "## " for headings, "- " / "1. " for list items. */
  marker: string;
  /** Editable payload. For code blocks this is the whole fenced snippet. */
  content: string;
  /** Untouched original line(s), used for blank lines and as a fallback. */
  raw: string;
}

let blockSeq = 0;
function nextId(): string {
  blockSeq += 1;
  return `pb-${blockSeq}`;
}

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})(\s+)(.*)$/;
const LIST_ITEM = /^([-*+]|\d+[.)])(\s+)(.*)$/;

/**
 * Split plan markdown into editable blocks.
 * Fenced code is kept as one block so dashes inside commands are not mistaken
 * for list items. Consecutive prose lines are grouped into one block.
 */
export function parsePlanBlocks(markdown: string): PlanBlock[] {
  const lines = (markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: PlanBlock[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";

    if (FENCE.test(raw)) {
      const codeLines: string[] = [raw];
      i += 1;
      while (i < lines.length) {
        const line = lines[i] ?? "";
        codeLines.push(line);
        i += 1;
        if (FENCE.test(line)) break;
      }
      const text = codeLines.join("\n");
      blocks.push({ id: nextId(), kind: "code", indent: "", marker: "", content: text, raw: text });
      continue;
    }

    if (!raw.trim()) {
      blocks.push({ id: nextId(), kind: "blank", indent: "", marker: "", content: "", raw });
      continue;
    }

    const indent = /^(\s*)/.exec(raw)?.[1] ?? "";
    const rest = raw.slice(indent.length);

    const heading = HEADING.exec(rest);
    if (heading) {
      blocks.push({
        id: nextId(),
        kind: "heading",
        indent,
        marker: `${heading[1]}${heading[2]}`,
        content: heading[3] ?? "",
        raw
      });
      continue;
    }

    const item = LIST_ITEM.exec(rest);
    if (item) {
      blocks.push({
        id: nextId(),
        kind: "item",
        indent,
        marker: `${item[1]}${item[2]}`,
        content: item[3] ?? "",
        raw
      });
      continue;
    }

    const previous = blocks[blocks.length - 1];
    if (previous?.kind === "text") {
      previous.content += `\n${rest}`;
      previous.raw += `\n${raw}`;
      continue;
    }
    blocks.push({ id: nextId(), kind: "text", indent, marker: "", content: rest, raw });
  }

  return blocks;
}

/** Rebuild markdown from blocks. Round-trips an untouched plan verbatim. */
export function serializePlanBlocks(blocks: PlanBlock[]): string {
  return blocks
    .map((block) => {
      if (block.kind === "blank") return "";
      if (block.kind === "code") return block.content;
      return `${block.indent}${block.marker}${block.content}`;
    })
    .join("\n");
}

export function createPlanBlock(kind: "heading" | "item" | "text", content = ""): PlanBlock {
  const marker = kind === "heading" ? "## " : kind === "item" ? "- " : "";
  return { id: nextId(), kind, indent: "", marker, content, raw: `${marker}${content}` };
}

/** Append before trailing blank lines so the plan keeps its original tail. */
export function appendPlanBlock(blocks: PlanBlock[], block: PlanBlock): PlanBlock[] {
  let index = blocks.length - 1;
  while (index >= 0 && blocks[index]?.kind === "blank") index -= 1;
  const next = [...blocks];
  next.splice(index + 1, 0, block);
  return next;
}

/** Choose a marker consistent with the list this new item is appended to. */
export function nextItemMarker(blocks: PlanBlock[], afterId: string): string {
  const start = blocks.findIndex((block) => block.id === afterId);
  for (let i = start; i >= 0; i -= 1) {
    const block = blocks[i];
    if (!block) continue;
    if (block.kind === "heading") break;
    if (block.kind === "item" && /^\d+[.)]\s/.test(block.marker)) {
      const current = Number.parseInt(block.marker, 10);
      if (Number.isFinite(current)) return `${current + 1}. `;
    }
    if (block.kind === "item") return "- ";
  }
  return "- ";
}
