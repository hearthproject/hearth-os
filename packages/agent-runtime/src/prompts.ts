import type { ExecutionMode, TaskRecord } from "@hearth/core";

export interface PromptBuildContext {
  task: TaskRecord;
  expectedOutputs: string[];
  availableTools: string[];
  mode: "build" | "plan";
  executionModeLabel?: string | undefined;
  goalBlock?: string | null | undefined;
  profileBlock?: string | null | undefined;
  extraBlocks?: string[] | undefined;
}

export interface PromptSection {
  id: string;
  priority: number;
  build(context: PromptBuildContext): string | string[] | null;
}

export interface PromptPart {
  id: string;
  content: string;
  dynamic?: boolean;
}

export interface ComposedPromptLayout {
  sections: Array<{ id: string; content: string; dynamic: boolean }>;
  stablePrefix: string;
  dynamicSuffix: string;
  text: string;
}

/** Keep stable instructions first and task-specific context last. */
export function composePromptLayout(parts: PromptPart[]): ComposedPromptLayout {
  const sections = parts
    .map((part) => ({ id: part.id, content: part.content.trim(), dynamic: part.dynamic === true }))
    .filter((part) => part.content.length > 0);
  const stablePrefix = sections.filter((part) => !part.dynamic).map((part) => part.content).join("\n\n");
  const dynamicSuffix = sections.filter((part) => part.dynamic).map((part) => part.content).join("\n\n");
  return {
    sections,
    stablePrefix,
    dynamicSuffix,
    text: [stablePrefix, dynamicSuffix].filter(Boolean).join("\n\n")
  };
}

/**
 * Ordered prompt registry. Every section is an isolated, testable unit; task
 * prompts are composed from it instead of ad-hoc string concatenation.
 */
export class PromptRegistry {
  private readonly sections = new Map<string, PromptSection>();

  constructor(initial: PromptSection[] = []) {
    for (const section of initial) this.register(section);
  }

  register(section: PromptSection): this {
    this.sections.set(section.id, section);
    return this;
  }

  remove(id: string): boolean {
    return this.sections.delete(id);
  }

  ids(): string[] {
    return [...this.sections.values()].sort((a, b) => a.priority - b.priority).map((section) => section.id);
  }

  render(context: PromptBuildContext): string {
    return this.renderSections(context).map((section) => section.content).join("\n\n");
  }

  /**
   * Same output as `render`, split into named sections for context
   * transparency. The order and separators must stay identical.
   */
  renderSections(context: PromptBuildContext, labels: Record<string, string> = {}): ComposedPromptSection[] {
    return [...this.sections.values()]
      .sort((a, b) => a.priority - b.priority)
      .flatMap((section) => {
        const value = section.build(context);
        if (!value) return [];
        const blocks = (Array.isArray(value) ? value : [value])
          .map((block) => block.trim())
          .filter(Boolean);
        if (blocks.length === 0) return [];
        return [{
          id: section.id,
          label: labels[section.id] ?? section.id,
          content: blocks.join("\n\n")
        }];
      });
  }
}

export const sharedAnswerContractPrompt = [
  "用户明确指定的语言、格式、字段名和输出结构优先。",
  "默认先给结论，通常不超过 3 段或 200 字，只保留结论、关键证据、产物路径和必要限制。",
  "用普通人能懂的话表达。必须使用术语时当场用一句话解释，不要堆砌缩写或内部实现名。",
  "只返回用户需要的结果。不要复述思考过程、工具流水账、无关背景或“我已经帮你……”之类的元话术。",
  "除非用户明确要求，不要生成固定报告章节、步骤标签、表格、result.md 或日志。任务需要文件时才创建文件。"
].join("\n");

export const executionContractPrompt = [
  "你是自主执行器。用户已经把任务交给你，默认一切都是已授权的：直接完成，不要询问“是否继续”“要不要我做”，也不要用方案、建议或承诺代替执行。",
  "除非缺少无法通过工具自行获得的凭据，否则不要停下来等用户确认。遇到失败先诊断并换一种可行方式重试；需要资料就自己搜索，需要技能就自己搜索并安装，需要命令就自己运行。",
  "普通构建、目标和任务模式拥有完整文件、网络和命令权限，不需要审批。只有用户显式进入 Plan Mode 时才必须只读。",
  "用工具真实完成并验证。没有执行就不能声称完成；无法验证的部分如实标注。",
  sharedAnswerContractPrompt
].join("\n");

export function skillRoutingPrompt(availableTools: string[]): string | null {
  if (!availableTools.includes("search_skills") || !availableTools.includes("install_skill")) return null;
  return [
    "涉及 Skill 时自己完成闭环：先 search_skills 搜索已安装技能和 GitHub，再 install_skill 安装。",
    "不要要求用户提供仓库地址、安装方式或确认；只有所有候选都失败时，才报告失败原因和已经尝试过的来源。"
  ].join("\n");
}

export const taskPromptRegistry = new PromptRegistry([
  {
    id: "identity",
    priority: 10,
    build: () => "你是 Hearth 的原生 Agent 执行器，在真实工作区里独立完成用户任务。回答使用简体中文；代码、命令、路径、标识符和提交信息保持英文。"
  },
  {
    id: "autonomy",
    priority: 20,
    build: () => executionContractPrompt
  },
  {
    id: "investigation",
    priority: 30,
    build: ({ availableTools }) => {
      const tools = new Set(availableTools);
      return [
        tools.has("list_files") || tools.has("glob") || tools.has("grep") || tools.has("read_file")
          ? "先了解真实环境和已有资料，再动手；不要假设文件存在或内容如你所想。"
          : "",
        tools.has("read_desktop_file")
          ? "读取工作区之外的文件用 read_desktop_file；read_file 只读工作区。读取被拒绝时换用可访问路径，不要反复重试同一路径。"
          : "",
        tools.has("read_document") ? "PDF、Word、Excel、CSV 等文档优先用 read_document。" : "",
        tools.has("write_spreadsheet") || tools.has("write_document")
          ? "需要表格或 Word 交付时使用 write_spreadsheet 或 write_document。"
          : ""
      ].filter(Boolean);
    }
  },
  {
    id: "skills",
    priority: 40,
    build: ({ availableTools }) => skillRoutingPrompt(availableTools)
  },
  {
    id: "completion",
    priority: 50,
    build: ({ availableTools }) => [
      availableTools.includes("finish_task")
        ? "任务完成后必须调用 finish_task，把最终结果直接写进 summary；不要只发一条普通文本就结束。如果产出了报告或结果文件，summary 必须包含文件里的核心结论正文——用户会直接在对话里读到它，不要只写“结果写入 xxx.md”。文件仍作为交付物保留。"
        : "",
      "最终输出只保留用户需要的结果和证据，不复述过程。"
    ].filter(Boolean)
  },
  {
    id: "task",
    priority: 60,
    build: ({ task, expectedOutputs, executionModeLabel }) => [
      `当前任务：${task.title}`,
      executionModeLabel ? `执行强度：${executionModeLabel}` : "",
      expectedOutputs.length > 0 ? `用户明确要求的产物：${expectedOutputs.join("、")}` : "没有强制文件产物；按任务实际需要决定是否写文件。"
    ].filter(Boolean)
  },
  {
    id: "goal",
    priority: 70,
    build: ({ goalBlock }) => goalBlock ?? null
  },
  {
    id: "profile",
    priority: 80,
    build: ({ profileBlock }) => profileBlock ?? null
  },
  {
    id: "extensions",
    priority: 90,
    build: ({ extraBlocks }) => extraBlocks ?? null
  }
]);

export interface ComposedPromptSection {
  id: string;
  label: string;
  content: string;
}

const PROMPT_SECTION_LABELS: Record<string, string> = {
  identity: "身份与角色",
  autonomy: "执行契约",
  investigation: "调查规范",
  skills: "技能路由",
  completion: "收尾要求",
  task: "任务信息",
  goal: "目标约束",
  profile: "任务画像",
  extensions: "扩展约束"
};

/**
 * Render the prompt as named sections. The joined result is byte-identical to
 * `render`, so prompt transparency can never change model behaviour.
 */
export function composeTaskPromptSections(context: PromptBuildContext): ComposedPromptSection[] {
  return taskPromptRegistry.renderSections(context, PROMPT_SECTION_LABELS);
}

export function composeTaskPrompt(context: PromptBuildContext): string {
  return composeTaskPromptSections(context).map((section) => section.content).join("\n\n");
}

export function executionModePrompt(mode: ExecutionMode | undefined, label: string, instruction: string): string {
  return mode ? `执行模式：${label}。${instruction}` : "";
}
