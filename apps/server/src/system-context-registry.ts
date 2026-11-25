/**
 * In-memory view of the exact system prompt the native executor sent to the
 * model. Prompts are large and only useful for the latest run, so they are not
 * persisted in the event log or the conversation snapshot.
 */

export interface SystemContextSection {
  id: string;
  label: string;
  chars: number;
  content: string;
}

export interface SystemContextRecord {
  taskId: string;
  model: string | null;
  capturedAt: string;
  prompt: string;
  sections: SystemContextSection[];
}

const MAX_RECORDS = 40;
const records = new Map<string, SystemContextRecord>();

export function rememberSystemContext(record: SystemContextRecord): void {
  records.delete(record.taskId);
  records.set(record.taskId, record);
  while (records.size > MAX_RECORDS) {
    const oldest = records.keys().next().value;
    if (oldest === undefined) break;
    records.delete(oldest);
  }
}

export function readSystemContext(taskId: string): SystemContextRecord | null {
  return records.get(taskId) ?? null;
}

export function clearSystemContext(): void {
  records.clear();
}

/**
 * Render the captured prompt as a readable Markdown document so the chat can
 * preview it with the same renderer used for artifacts and reports.
 */
export function renderSystemContextMarkdown(record: SystemContextRecord): string {
  const totalChars = record.sections.reduce((sum, section) => sum + section.chars, 0);
  const head = [
    "# 本轮系统上下文",
    "",
    `- 模型：${record.model ?? "未知"}`,
    `- 采集时间：${record.capturedAt}`,
    `- 总长度：${totalChars} 字符（约 ${Math.ceil(totalChars / 4)} tokens）`,
    "",
    "> 这是本轮实际发送给模型的系统提示词原文。工具定义不包含在内。"
  ].join("\n");
  if (record.sections.length === 0) {
    return `${head}\n\n## 系统提示词\n\n${record.prompt}`;
  }
  const body = record.sections.map((section, index) => {
    const title = `## ${index + 1}. ${section.label}（${section.chars} 字符）`;
    return `${title}\n\n${section.content}`;
  }).join("\n\n");
  return `${head}\n\n${body}`;
}
