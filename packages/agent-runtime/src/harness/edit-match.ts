export type EditMatchTier = "exact" | "line-trim" | "whitespace" | "indent" | "unicode" | "block-anchor" | "similarity";

export interface EditMatch {
  start: number;
  end: number;
  matchedText: string;
  tier: EditMatchTier;
}

export interface EditMatchFailure {
  error: string;
  nearest: string;
}

export interface NormalizedFile {
  bom: string;
  eol: "\n" | "\r\n";
  text: string;
}

export function normalizeFile(content: string): NormalizedFile {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? content.slice(1) : content;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  return { bom, eol, text: body.replace(/\r\n/g, "\n") };
}

export function restoreFile(normalized: NormalizedFile): string {
  const body = normalized.eol === "\r\n" ? normalized.text.replace(/\n/g, "\r\n") : normalized.text;
  return `${normalized.bom}${body}`;
}

export function findEditMatch(content: string, oldText: string): EditMatch | EditMatchFailure {
  const needle = oldText.replace(/\r\n/g, "\n");
  if (!needle) return { error: "oldText 不能为空", nearest: nearestSnippet(content, "") };

  const exact = uniqueIndex(content, needle);
  if (exact !== null) return { start: exact, end: exact + needle.length, matchedText: needle, tier: "exact" };

  const lineTrim = matchByLineTransform(content, needle, (line) => line.trim(), "line-trim");
  if (lineTrim) return lineTrim;

  const whitespace = matchByLineTransform(content, needle, (line) => line.replace(/[ \t]+/g, " ").trim(), "whitespace");
  if (whitespace) return whitespace;

  const indent = matchByLineTransform(content, needle, (line) => line.replace(/^[ \t]+/, ""), "indent");
  if (indent) return indent;

  const unicode = matchByLineTransform(content, needle, normalizeUnicode, "unicode");
  if (unicode) return unicode;

  const anchor = matchByAnchor(content, needle);
  if (anchor) return anchor;

  const similar = matchBySimilarity(content, needle);
  if (similar) return similar;

  return {
    error: `未找到要替换的文本（已尝试精确、去缩进、空白归一、块锚点和相似匹配）。最接近的片段：\n${nearestSnippet(content, needle)}`,
    nearest: nearestSnippet(content, needle)
  };
}

export function countEditMatches(content: string, oldText: string): number {
  const needle = oldText.replace(/\r\n/g, "\n");
  if (!needle) return 0;
  let count = 0;
  let index = content.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = content.indexOf(needle, index + needle.length);
  }
  if (count > 0) return count;
  const match = findEditMatch(content, needle);
  return "start" in match ? 1 : 0;
}

export function applyEdit(content: string, match: EditMatch, newText: string): string {
  return `${content.slice(0, match.start)}${newText.replace(/\r\n/g, "\n")}${content.slice(match.end)}`;
}

function uniqueIndex(haystack: string, needle: string): number | null {
  const first = haystack.indexOf(needle);
  if (first < 0) return null;
  const second = haystack.indexOf(needle, first + 1);
  return second < 0 ? first : null;
}

interface LineInfo {
  text: string;
  start: number;
  end: number;
}

function linesWithOffsets(content: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let start = 0;
  for (let index = 0; index <= content.length; index += 1) {
    if (index === content.length || content.charCodeAt(index) === 10) {
      lines.push({ text: content.slice(start, index), start, end: index });
      start = index + 1;
    }
  }
  return lines;
}

function matchByLineTransform(content: string, needle: string, transform: (line: string) => string, tier: EditMatchTier): EditMatch | null {
  const hayLines = linesWithOffsets(content);
  const needleLines = needle.split("\n").map(transform);
  if (needleLines.length === 0) return null;
  const matches: Array<{ start: number; end: number }> = [];
  for (let index = 0; index + needleLines.length <= hayLines.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needleLines.length; offset += 1) {
      if (transform(hayLines[index + offset]!.text) !== needleLines[offset]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    matches.push({ start: hayLines[index]!.start, end: hayLines[index + needleLines.length - 1]!.end });
  }
  if (matches.length !== 1) return null;
  const [match] = matches;
  return { start: match!.start, end: match!.end, matchedText: content.slice(match!.start, match!.end), tier };
}

function matchByAnchor(content: string, needle: string): EditMatch | null {
  const hayLines = linesWithOffsets(content);
  const needleLines = needle.split("\n");
  const first = needleLines.find((line) => line.trim())?.trim();
  const last = [...needleLines].reverse().find((line) => line.trim())?.trim();
  if (!first || !last) return null;
  const candidates: Array<{ start: number; end: number; score: number }> = [];
  for (let index = 0; index + needleLines.length <= hayLines.length; index += 1) {
    const firstLine = hayLines[index]!.text.trim();
    const lastLine = hayLines[index + needleLines.length - 1]!.text.trim();
    if (firstLine !== first || lastLine !== last) continue;
    const start = hayLines[index]!.start;
    const end = hayLines[index + needleLines.length - 1]!.end;
    const block = content.slice(start, end);
    candidates.push({ start, end, score: similarity(block, needle) });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length > 1 && candidates[0]!.score - candidates[1]!.score < 0.05) return null;
  if (candidates[0]!.score < 0.6) return null;
  return { start: candidates[0]!.start, end: candidates[0]!.end, matchedText: content.slice(candidates[0]!.start, candidates[0]!.end), tier: "block-anchor" };
}

function matchBySimilarity(content: string, needle: string): EditMatch | null {
  const hayLines = linesWithOffsets(content);
  const needleLines = needle.split("\n").length;
  if (needleLines === 0 || hayLines.length < needleLines) return null;
  const candidates: Array<{ start: number; end: number; score: number }> = [];
  for (let index = 0; index + needleLines <= hayLines.length; index += 1) {
    const start = hayLines[index]!.start;
    const end = hayLines[index + needleLines - 1]!.end;
    const score = similarity(content.slice(start, end), needle);
    if (score >= 0.9) candidates.push({ start, end, score });
  }
  if (candidates.length !== 1) return null;
  return { start: candidates[0]!.start, end: candidates[0]!.end, matchedText: content.slice(candidates[0]!.start, candidates[0]!.end), tier: "similarity" };
}

function similarity(a: string, b: string): number {
  const left = bigrams(a.replace(/\s+/g, " "));
  const right = bigrams(b.replace(/\s+/g, " "));
  if (left.size === 0 || right.size === 0) return 0;
  let common = 0;
  for (const gram of left) if (right.has(gram)) common += 1;
  return (2 * common) / (left.size + right.size);
}

function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) set.add(text.slice(index, index + 2));
  return set;
}

function nearestSnippet(content: string, needle: string): string {
  const lines = content.split("\n");
  const needleFirst = needle.split("\n").find((line) => line.trim())?.trim() ?? "";
  let bestIndex = 0;
  let bestScore = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const score = needleFirst ? similarity(lines[index]!.trim(), needleFirst) : 0;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  const start = Math.max(0, bestIndex - 3);
  const end = Math.min(lines.length, bestIndex + 4);
  return lines.slice(start, end).map((line, offset) => `${start + offset + 1}\t${line}`).join("\n");
}

function normalizeUnicode(line: string): string {
  return line
    .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .normalize("NFKC");
}

