export interface OmissionPlaceholder {
  line: number;
  text: string;
}

const PLACEHOLDER_LINE = /^\s*(?:(?:\/\/|#|<!--|\/\*)\s*)?(?:\.{3,}|…)(?:\s*(?:\*\/|-->))?\s*$/;
const COMMENT_ELLIPSIS = /^\s*(?:\/\/|#|<!--|\/\*)\s*(?:\.{3,}|…)(?:\s*(?:existing|rest of|remaining|unchanged|same as before|其他|其余|剩余|省略|未改动|保持不变))?[^\n]*(?:\*\/|-->)?\s*$/i;
const OMITTED_COMMENT = /^\s*(?:\/\/|#|<!--|\/\*)\s*(?:(?:existing|rest of|remaining|unchanged|same as before)\b|(?:其他|其余|剩余|省略|未改动|保持不变))/i;

export function findOmissionPlaceholder(text: string): OmissionPlaceholder | null {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (PLACEHOLDER_LINE.test(line) || COMMENT_ELLIPSIS.test(line) || OMITTED_COMMENT.test(line)) {
      return { line: index + 1, text: line.trim() };
    }
  }
  return null;
}

export function omissionPlaceholderError(text: string, label = "oldText"): string | null {
  const placeholder = findOmissionPlaceholder(text);
  if (!placeholder) return null;
  return `${label} 第 ${placeholder.line} 行含有省略占位符“${placeholder.text}”。请提供完整的真实原文，不要用 ...、… 或“其余不变”代替；可以先用 read_file 重新读取相关片段。`;
}
