import { unzipSync } from "fflate";

export interface SheetTable {
  name: string;
  rows: string[][];
}

export interface SlideText {
  index: number;
  lines: string[];
}

const MAX_ROWS = 200;
const MAX_COLUMNS = 24;
const MAX_SLIDES = 80;
const MAX_TEXT_LENGTH = 240;

/** 读取 xlsx 的所有工作表（前 200 行 × 24 列），够用于对话内快速核对。 */
export function parseXlsx(bytes: Uint8Array): SheetTable[] {
  const files = unzipSync(bytes);
  const sharedStrings = parseSharedStrings(parseXml(readEntry(files, "xl/sharedStrings.xml")));
  const workbook = parseXml(readEntry(files, "xl/workbook.xml"));
  const rels = parseRelationships(parseXml(readEntry(files, "xl/_rels/workbook.xml.rels")));
  const sheets = Array.from(workbook.getElementsByTagName("sheet"));
  const tables: SheetTable[] = [];
  for (const sheet of sheets) {
    const name = sheet.getAttribute("name") ?? `Sheet${tables.length + 1}`;
    const relationId = sheet.getAttribute("r:id")
      ?? sheet.getAttribute("id")
      ?? sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const target = relationId ? rels.get(relationId) : null;
    const path = target ? normalizeSheetPath(target) : `xl/worksheets/sheet${tables.length + 1}.xml`;
    const xml = readEntry(files, path);
    if (!xml) continue;
    tables.push({ name, rows: parseWorksheet(parseXml(xml), sharedStrings) });
  }
  return tables;
}

/** 读取 pptx 每页的文字，按段落分行，保留页序。 */
export function parsePptx(bytes: Uint8Array): SlideText[] {
  const files = unzipSync(bytes);
  const presentation = parseXml(readEntry(files, "ppt/presentation.xml"));
  const rels = parseRelationships(parseXml(readEntry(files, "ppt/_rels/presentation.xml.rels")));
  const slideIds = Array.from(presentation.getElementsByTagName("p:sldId"));
  const ordered: Array<{ index: number; path: string }> = [];
  slideIds.forEach((item, index) => {
    const relationId = item.getAttribute("r:id")
      ?? item.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const target = relationId ? rels.get(relationId) : null;
    if (target) ordered.push({ index: index + 1, path: normalizeSlidePath(target) });
  });
  if (ordered.length === 0) {
    for (const path of Object.keys(files).filter((item) => /^ppt\/slides\/slide\d+\.xml$/i.test(item)).sort(slideSort)) {
      ordered.push({ index: ordered.length + 1, path });
    }
  }
  const slides: SlideText[] = [];
  for (const entry of ordered.slice(0, MAX_SLIDES)) {
    const xml = readEntry(files, entry.path);
    if (!xml) continue;
    slides.push({ index: entry.index, lines: parseSlideLines(parseXml(xml)) });
  }
  return slides;
}

/** 读取 docx 正文段落（不含页眉页脚，满足对话内预览）。 */
export function parseDocx(bytes: Uint8Array): string[] {
  const files = unzipSync(bytes);
  const xml = readEntry(files, "word/document.xml");
  if (!xml) return [];
  const paragraphs = Array.from(parseXml(xml).getElementsByTagName("w:p"));
  return paragraphs
    .map((paragraph) => Array.from(paragraph.getElementsByTagName("w:t")).map((item) => item.textContent ?? "").join(""))
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseDelimited(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/\r\n/g, "\n");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === "," || char === ";") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (rows.length >= MAX_ROWS) return rows;
    } else {
      cell += char;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((line) => line.slice(0, MAX_COLUMNS));
}

function parseWorksheet(xml: Document, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  for (const row of Array.from(xml.getElementsByTagName("row"))) {
    if (rows.length >= MAX_ROWS) break;
    const line: string[] = [];
    for (const cell of Array.from(row.getElementsByTagName("c"))) {
      const column = columnIndex(cell.getAttribute("r") ?? "");
      while (line.length < column && line.length < MAX_COLUMNS) line.push("");
      if (line.length >= MAX_COLUMNS) break;
      const type = cell.getAttribute("t");
      const value = cell.getElementsByTagName("v")[0]?.textContent ?? "";
      const inline = Array.from(cell.getElementsByTagName("t")).map((item) => item.textContent ?? "").join("");
      const text = type === "s" ? sharedStrings[Number(value)] ?? "" : inline || value;
      line[column] = text.slice(0, MAX_TEXT_LENGTH);
    }
    rows.push(trimTrailingEmpty(line));
  }
  return rows;
}

function parseSharedStrings(xml: Document | null): string[] {
  if (!xml) return [];
  return Array.from(xml.getElementsByTagName("si"))
    .map((item) => Array.from(item.getElementsByTagName("t")).map((node) => node.textContent ?? "").join(""))
    .map((text) => text.slice(0, MAX_TEXT_LENGTH));
}

function parseSlideLines(xml: Document): string[] {
  const paragraphs = Array.from(xml.getElementsByTagName("a:p"));
  const lines = paragraphs
    .map((paragraph) => Array.from(paragraph.getElementsByTagName("a:t")).map((item) => item.textContent ?? "").join("").trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : Array.from(xml.getElementsByTagName("a:t")).map((item) => item.textContent ?? "").filter(Boolean);
}

function parseRelationships(xml: Document | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!xml) return map;
  for (const relation of Array.from(xml.getElementsByTagName("Relationship"))) {
    const id = relation.getAttribute("Id");
    const target = relation.getAttribute("Target");
    if (id && target) map.set(id, target);
  }
  return map;
}

function parseXml(bytes: Uint8Array | null): Document {
  const text = bytes ? new TextDecoder("utf-8").decode(bytes) : "<empty/>";
  return new DOMParser().parseFromString(text, "application/xml");
}

function readEntry(files: Record<string, Uint8Array>, path: string): Uint8Array | null {
  const direct = files[path];
  if (direct) return direct;
  const key = Object.keys(files).find((item) => item.toLowerCase() === path.toLowerCase());
  return key ? files[key] ?? null : null;
}

function normalizeSheetPath(target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  return target.startsWith("xl/") ? target : `xl/${target}`;
}

function normalizeSlidePath(target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  return target.startsWith("ppt/") ? target : `ppt/${target}`;
}

function slideSort(left: string, right: string): number {
  const leftNumber = Number(/\d+/.exec(left)?.[0] ?? 0);
  const rightNumber = Number(/\d+/.exec(right)?.[0] ?? 0);
  return leftNumber - rightNumber;
}

function columnIndex(reference: string): number {
  const letters = reference.replace(/[^A-Za-z]/g, "").toUpperCase();
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return Math.max(0, index - 1);
}

function trimTrailingEmpty(row: string[]): string[] {
  const result = [...row];
  while (result.length > 0 && !result[result.length - 1]) result.pop();
  return result;
}
