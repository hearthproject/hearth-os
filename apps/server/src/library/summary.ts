import type { LibraryNode } from "@hearth/core";
import { streamAgentTurn } from "../model-agent.ts";
import { chatModelConfigured, type ModelSettings } from "../model-settings.ts";

export interface LibrarySummaryChild {
  id: string;
  title: string;
  kind: LibraryNode["kind"];
  excerpt: string | null;
  summary: string | null;
  updatedAt: string;
}

export interface LibrarySummarySource {
  node: LibraryNode;
  children: LibrarySummaryChild[];
}

export interface LibrarySummaryValue {
  content: string;
  model: string | null;
  tokenCount: number;
}

export type LibrarySummaryGenerator = (source: LibrarySummarySource) => Promise<LibrarySummaryValue | null>;

export function createModelSummaryGenerator(getSettings: () => ModelSettings | null): LibrarySummaryGenerator {
  return async (source) => {
    const settings = getSettings();
    if (!settings || !chatModelConfigured(settings)) return null;
    const lines = source.children.slice(0, 80).map((child) => {
      const detail = child.summary || child.excerpt || "暂无正文";
      return `- [${child.kind}] ${clip(child.title, 120)}：${clip(detail.replace(/\s+/g, " "), 320)}`;
    });
    const prompt = [
      "你是 Hearth 资料库的目录摘要器。请根据目录名称和下面的条目，用简洁中文概括这个目录里有什么、适合在什么情况下查阅。",
      "只输出摘要正文，2 到 4 句话，不要 Markdown 标题，不要编造没有出现的内容。",
      "",
      `目录：${source.node.path}`,
      `名称：${source.node.title}`,
      `条目数：${source.children.length}`,
      "",
      "条目：",
      lines.join("\n") || "- 暂无条目"
    ].join("\n");
    try {
      const turn = await streamAgentTurn(settings, [{ role: "user", content: prompt }], [], () => undefined, {
        temperature: 0,
        maxTokens: 360,
        timeoutMs: 30_000
      });
      const content = turn.content.trim();
      if (!content) return null;
      return {
        content: clip(content, 1_200),
        model: settings.model,
        tokenCount: Math.max(1, Math.ceil((prompt.length + content.length) / 4))
      };
    } catch {
      return null;
    }
  };
}

export function localSummary(source: LibrarySummarySource): LibrarySummaryValue {
  if (source.children.length === 0) {
    return { content: `${source.node.title}目前没有内容。`, model: null, tokenCount: 8 };
  }
  const kinds = new Map<string, number>();
  for (const child of source.children) kinds.set(child.kind, (kinds.get(child.kind) ?? 0) + 1);
  const kindSummary = [...kinds.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([kind, count]) => `${kindLabel(kind)} ${count} 项`)
    .join("、");
  const titles = source.children.slice(0, 8).map((child) => child.title).join("、");
  const more = source.children.length > 8 ? "等" : "";
  return {
    content: `${source.node.title}共有 ${source.children.length} 项内容，主要包括${kindSummary}。可以在这里找到${titles}${more}。`,
    model: null,
    tokenCount: Math.max(12, Math.ceil(source.children.length * 4))
  };
}

function kindLabel(kind: string): string {
  return ({
    root: "分类",
    memory: "记忆",
    task: "任务",
    source: "资料",
    artifact: "成果",
    file: "文件",
    folder: "文件夹",
    skill: "技能",
    project: "项目"
  } as Record<string, string>)[kind] ?? kind;
}

function clip(value: string, limit: number): string {
  const clean = value.trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}
