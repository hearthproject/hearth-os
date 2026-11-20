import type { AgentTool, AgentToolDefinition } from "../types.ts";

/** Tools that stay directly callable even when the catalog defers the rest. */
export const CORE_TOOL_NAMES = [
  "read_file",
  "read_document",
  "list_files",
  "search_text",
  "glob",
  "grep",
  "write_file",
  "write_document",
  "write_spreadsheet",
  "edit_file",
  "apply_patch",
  "shell",
  "shell_output",
  "shell_wait",
  "shell_kill",
  "capture_screen",
  "fetch_url",
  "ask_user",
  "finish_task",
  "submit_plan",
  "create_goal",
  "update_goal",
  "update_plan",
  "memory_read",
  "memory_write",
  "memory_search"
];

export const TOOL_SEARCH_NAME = "tool_search";
export const DEFAULT_MAX_DIRECT_TOOLS = 32;

export interface ToolCatalogOptions {
  maxDirectTools?: number;
  coreTools?: string[];
  exposed?: string[];
}

export interface ToolSearchResult {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  score: number;
}

export function toolSearchDefinition(hiddenCount: number): AgentToolDefinition {
  return {
    name: TOOL_SEARCH_NAME,
    description: `Search ${hiddenCount} deferred tools by keyword. Returns matching tool schemas; a discovered tool becomes callable on the next turn.`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords such as jira, calendar, database or browser" },
        limit: { type: "number", description: "Maximum results, default 5, max 10" }
      },
      required: ["query"],
      additionalProperties: false
    }
  };
}

export class ToolCatalog {
  readonly tools: AgentTool[];
  readonly deferred: boolean;
  private readonly core: Set<string>;
  private readonly exposedNames: Set<string>;
  private readonly byName: Map<string, AgentTool>;

  constructor(tools: AgentTool[], options: ToolCatalogOptions = {}) {
    this.tools = tools;
    this.byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
    this.core = new Set(options.coreTools ?? CORE_TOOL_NAMES);
    this.deferred = tools.length > (options.maxDirectTools ?? DEFAULT_MAX_DIRECT_TOOLS);
    this.exposedNames = new Set(
      (options.exposed ?? []).filter((name) => typeof name === "string" && this.byName.has(name) && !this.isDirect(name))
    );
  }

  isDirect(name: string): boolean {
    return this.byName.has(name) && (!this.deferred || this.core.has(name));
  }

  isCallable(name: string): boolean {
    return this.isDirect(name) || this.exposedNames.has(name);
  }

  exposed(): string[] {
    return [...this.exposedNames];
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  resolve(name: string): AgentTool | undefined {
    return this.isCallable(name) ? this.byName.get(name) : undefined;
  }

  definitions(): AgentToolDefinition[] {
    if (!this.deferred) return this.tools.map((tool) => tool.definition);
    const direct = this.tools.filter((tool) => this.isDirect(tool.definition.name));
    const exposed = [...this.exposedNames]
      .map((name) => this.byName.get(name))
      .filter((tool): tool is AgentTool => tool !== undefined);
    return [...direct, ...exposed].map((tool) => tool.definition);
  }

  search(query: string, limit = 5): ToolSearchResult[] {
    const terms = query.toLowerCase().split(/\s+/).map((term) => term.trim()).filter(Boolean);
    if (terms.length === 0) return [];
    const results: ToolSearchResult[] = [];
    for (const tool of this.tools) {
      if (this.isDirect(tool.definition.name)) continue;
      const name = tool.definition.name.toLowerCase();
      const description = tool.definition.description.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (name === term) score += 12;
        else if (name.includes(term)) score += 5;
        if (name.startsWith(term)) score += 4;
        if (description.includes(term)) score += 2;
      }
      if (score === 0) continue;
      results.push({
        name: tool.definition.name,
        description: tool.definition.description,
        parameters: tool.definition.parameters,
        score
      });
    }
    return results.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name)).slice(0, Math.max(1, Math.min(10, limit)));
  }

  expose(names: string[]): void {
    for (const name of names) {
      if (this.byName.has(name) && !this.isDirect(name)) this.exposedNames.add(name);
    }
  }
}
