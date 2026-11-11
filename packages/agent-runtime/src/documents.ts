import { extname } from "node:path";
import * as cheerio from "cheerio";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
  type IParagraphOptions
} from "docx";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import type { SourceCoverage } from "@hearth/core";

const MAX_EXTRACTED_BYTES = 5 * 1024 * 1024;
const MAX_SHEET_ROWS = 5_000;
const MAX_SHEET_COLUMNS = 200;
const MAX_PDF_PAGES = 500;

export class UnsupportedSourceFormatError extends Error {
  readonly code = "unsupported_source_format";

  constructor(extension: string) {
    super(`暂不支持读取 ${extension || "该"} 格式的来源文件`);
    this.name = "UnsupportedSourceFormatError";
  }
}

export interface ExtractionResult {
  markdown: string;
  title: string | null;
  coverage: SourceCoverage;
}

export interface SpreadsheetSheetInput {
  name: string;
  rows: Array<Array<string | number | boolean | null>>;
}

export interface DocumentBlockInput {
  type: "heading" | "paragraph" | "bullet" | "numbered";
  text: string;
  level?: number;
}

export async function extractSourceBytes(bytes: Uint8Array, fileName: string): Promise<ExtractionResult> {
  const extension = extname(fileName).toLowerCase();
  if (extension === ".md" || extension === ".markdown" || extension === ".txt") {
    return extractText(decodeText(bytes));
  }
  if (extension === ".csv") return extractCsv(decodeText(bytes), fileName);
  if (extension === ".json") return extractJson(decodeText(bytes), fileName);
  if (extension === ".html" || extension === ".htm") return extractHtml(decodeText(bytes), fileName);
  if (extension === ".pdf") return extractPdf(bytes, fileName);
  if (extension === ".docx") return extractDocx(bytes, fileName);
  if (extension === ".xlsx") return extractXlsx(bytes, fileName);
  throw new UnsupportedSourceFormatError(extension);
}

export async function writeSpreadsheetBytes(sheets: SpreadsheetSheetInput[]): Promise<Uint8Array> {
  if (sheets.length === 0) throw new Error("至少需要一个工作表");
  if (sheets.length > 50) throw new Error("工作表数量不能超过 50");
  const workbook = new ExcelJS.Workbook();
  const names = new Set<string>();
  for (const input of sheets) {
    const name = input.name.trim();
    if (!name || name.length > 31 || /[\\/*?:[\]]/.test(name)) throw new Error(`工作表名称无效：${input.name}`);
    if (names.has(name.toLowerCase())) throw new Error(`工作表名称重复：${name}`);
    names.add(name.toLowerCase());
    if (input.rows.length > MAX_SHEET_ROWS) throw new Error(`工作表 ${name} 超过 ${MAX_SHEET_ROWS} 行`);
    if (input.rows.some((row) => row.length > MAX_SHEET_COLUMNS)) throw new Error(`工作表 ${name} 超过 ${MAX_SHEET_COLUMNS} 列`);
    const sheet = workbook.addWorksheet(name);
    for (const row of input.rows) sheet.addRow(row.map((value) => value ?? null));
    if (input.rows.length > 0) {
      sheet.getRow(1).font = { bold: true };
      sheet.views = [{ state: "frozen", ySplit: 1 }];
    }
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer() as ArrayBuffer);
}

export async function writeDocumentBytes(title: string | null, blocks: DocumentBlockInput[]): Promise<Uint8Array> {
  if (blocks.length > 5_000) throw new Error("文档段落数量不能超过 5000");
  const paragraphs: Paragraph[] = [];
  if (title?.trim()) {
    paragraphs.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title.trim())] }));
  }
  for (const block of blocks) {
    const text = block.text.trim();
    if (!text) continue;
    const options: IParagraphOptions = {
      children: [new TextRun(text)],
      ...(block.type === "heading" ? { heading: headingLevel(block.level) } : {}),
      ...(block.type === "bullet" ? { bullet: { level: Math.max(0, Math.min(8, block.level ?? 0)) } } : {}),
      ...(block.type === "numbered" ? { numbering: { reference: "hearth-numbering", level: Math.max(0, Math.min(8, block.level ?? 0)) } } : {})
    };
    paragraphs.push(new Paragraph(options));
  }
  if (paragraphs.length === 0) throw new Error("文档没有可写入的内容");
  const document = new Document({
    numbering: {
      config: [{
        reference: "hearth-numbering",
        levels: Array.from({ length: 9 }, (_, level) => ({
          level,
          format: LevelFormat.DECIMAL,
          text: `%${level + 1}.`,
          alignment: AlignmentType.START
        }))
      }]
    },
    sections: [{ children: paragraphs }]
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

function headingLevel(level = 1): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  if (level <= 1) return HeadingLevel.HEADING_1;
  if (level === 2) return HeadingLevel.HEADING_2;
  if (level === 3) return HeadingLevel.HEADING_3;
  if (level === 4) return HeadingLevel.HEADING_4;
  if (level === 5) return HeadingLevel.HEADING_5;
  return HeadingLevel.HEADING_6;
}

function extractText(text: string): ExtractionResult {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trimEnd();
  if (!normalized.trim()) throw new Error("来源文件没有可提取的正文");
  return finish(normalized, firstHeading(normalized), []);
}

function extractJson(text: string, fileName: string): ExtractionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("JSON 来源无法解析");
  }
  const markdown = ["```json", JSON.stringify(parsed, null, 2), "```"].join("\n");
  return finish(markdown, fileName.replace(/\.[^.]+$/, ""), []);
}

function extractHtml(text: string, fileName: string): ExtractionResult {
  const extracted = extractMarkdown(text, "https://local.invalid/");
  if (!extracted.markdown.trim()) throw new Error("HTML 来源没有可提取的正文");
  return finish(extracted.markdown, extracted.title === "未命名网页" ? fileName.replace(/\.[^.]+$/, "") : extracted.title, []);
}

function extractCsv(text: string, fileName: string): ExtractionResult {
  const rows = parseDelimited(text);
  if (rows.length === 0) throw new Error("CSV 来源没有数据行");
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const gaps: string[] = [];
  const limited = body.slice(0, MAX_SHEET_ROWS);
  if (body.length > limited.length) gaps.push(`CSV 共 ${body.length} 行，仅提取前 ${limited.length} 行`);
  const markdown = markdownTable(["源文件行", ...header], limited.map((row, index) => [String(index + 2), ...row]));
  return finish(markdown, fileName.replace(/\.[^.]+$/, ""), gaps, limited.length + 1);
}

async function extractPdf(bytes: Uint8Array, fileName: string): Promise<ExtractionResult> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useWorkerFetch: false });
  const document = await loading.promise;
  const gaps: string[] = [];
  const parts: string[] = [];
  const pageCount = Math.min(document.numPages, MAX_PDF_PAGES);
  if (document.numPages > pageCount) gaps.push(`PDF 共 ${document.numPages} 页，仅提取前 ${pageCount} 页`);
  let title: string | null = null;
  let paragraphs = 0;
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines: string[] = [];
    let line = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      line += item.str;
      if (item.hasEOL) {
        if (line.trim()) lines.push(line.trim());
        line = "";
      } else if (item.str && !/\s$/.test(item.str)) {
        line += " ";
      }
    }
    if (line.trim()) lines.push(line.trim());
    const text = lines.join("\n").trim();
    if (!text) {
      gaps.push(`第 ${pageNumber} 页没有可提取文字`);
      continue;
    }
    if (!title) title = lines.find((entry) => entry.length > 0) ?? null;
    paragraphs += lines.length;
    parts.push(`## 第 ${pageNumber} 页\n\n${text}`);
  }
  await loading.destroy();
  if (parts.length === 0) throw new Error("PDF 没有可提取的文字，可能是扫描件");
  return finish(parts.join("\n\n"), title ?? fileName.replace(/\.[^.]+$/, ""), gaps, paragraphs, pageCount);
}

async function extractDocx(bytes: Uint8Array, fileName: string): Promise<ExtractionResult> {
  const result = await mammoth.convertToHtml(
    { buffer: Buffer.from(bytes) },
    { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) }
  );
  const html = result.value.replace(/<img\b[^>]*>/gi, "");
  const extracted = extractMarkdown(html, "https://local.invalid/");
  if (!extracted.markdown.trim()) throw new Error("DOCX 来源没有可提取的正文");
  const gaps = result.messages.filter((message) => message.type === "warning" || message.type === "error").map((message) => message.message);
  return finish(extracted.markdown, extracted.title === "未命名网页" ? fileName.replace(/\.[^.]+$/, "") : extracted.title, gaps);
}

async function extractXlsx(bytes: Uint8Array, fileName: string): Promise<ExtractionResult> {
  const workbook = new ExcelJS.Workbook();
  const workbookBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  await workbook.xlsx.load(workbookBytes);
  const sections: string[] = [];
  const sheets: string[] = [];
  const gaps: string[] = [];
  let title: string | null = null;
  let paragraphs = 0;
  for (const worksheet of workbook.worksheets) {
    const rows: string[][] = [];
    let columnCount = 0;
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rows.length >= MAX_SHEET_ROWS) return;
      const values: string[] = [];
      const count = Math.min(row.cellCount, MAX_SHEET_COLUMNS);
      columnCount = Math.max(columnCount, count);
      for (let column = 1; column <= count; column += 1) {
        values.push(row.getCell(column).text.replace(/\r?\n/g, " ").trim());
      }
      rows.push([String(rowNumber), ...values]);
    });
    if (rows.length === 0) continue;
    if (worksheet.rowCount > MAX_SHEET_ROWS) gaps.push(`${worksheet.name} 共 ${worksheet.rowCount} 行，仅提取前 ${MAX_SHEET_ROWS} 行`);
    if (columnCount > MAX_SHEET_COLUMNS) gaps.push(`${worksheet.name} 共 ${columnCount} 列，仅提取前 ${MAX_SHEET_COLUMNS} 列`);
    sheets.push(worksheet.name);
    const header = ["源文件行"];
    for (let column = 1; column <= columnCount; column += 1) header.push(`列 ${column}`);
    sections.push(`## 工作表：${worksheet.name}\n\n${markdownTable(header, rows)}`);
    paragraphs += rows.length;
    title ??= worksheet.name;
  }
  if (sections.length === 0) throw new Error("XLSX 没有可提取的工作表内容");
  return finish(sections.join("\n\n"), title ?? fileName.replace(/\.[^.]+$/, ""), gaps, paragraphs, null, sheets);
}

function parseDelimited(text: string): string[][] {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const delimiter = detectDelimiter(normalized);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (quoted) {
      if (character === '"' && normalized[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === delimiter) {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => value.trim().length > 0));
}

function detectDelimiter(text: string): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const counts = [",", "\t", ";"].map((delimiter) => [delimiter, firstLine.split(delimiter).length - 1] as const);
  counts.sort((left, right) => right[1] - left[1]);
  return counts[0]?.[0] ?? ",";
}

function markdownTable(header: string[], rows: string[][]): string {
  const escapedHeader = header.map(escapeTableCell);
  const lines = [`| ${escapedHeader.join(" | ")} |`, `| ${escapedHeader.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${header.map((_, index) => escapeTableCell(row[index] ?? "")).join(" | ")} |`);
  return lines.join("\n");
}

function escapeTableCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function finish(
  markdown: string,
  title: string | null,
  gaps: string[],
  paragraphs = countParagraphs(markdown),
  pages: number | null = null,
  sheets: string[] = []
): ExtractionResult {
  const truncated = truncateMarkdown(markdown);
  const finalGaps = truncated ? [...gaps, "提取内容超过 5 MB，已截断"] : gaps;
  return {
    markdown: truncated,
    title,
    coverage: { complete: finalGaps.length === 0, pages, paragraphs, sheets, gaps: finalGaps }
  };
}

function truncateMarkdown(markdown: string): string {
  if (Buffer.byteLength(markdown, "utf8") <= MAX_EXTRACTED_BYTES) return markdown;
  let value = markdown.slice(0, MAX_EXTRACTED_BYTES);
  while (Buffer.byteLength(value, "utf8") > MAX_EXTRACTED_BYTES) value = value.slice(0, -1);
  return `${value}\n\n[内容已截断]`;
}

function countParagraphs(markdown: string): number {
  return markdown.split(/\n\s*\n/).filter((part) => part.trim()).length;
}

function firstHeading(markdown: string): string | null {
  return /^#{1,6}\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? null;
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gb18030").decode(bytes);
  }
}

export function extractMarkdown(html: string, baseUrl: string): { title: string; markdown: string } {
  const $ = cheerio.load(html);
  const title = ($("meta[property='og:title']").attr("content") || $("title").first().text() || $("h1").first().text() || "")
    .replace(/\s+/g, " ")
    .trim();
  $("script,style,noscript,svg,iframe,form,nav,footer,aside,header,[role='navigation'],[aria-hidden='true']").remove();
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
    try {
      $(element).attr("href", new URL(href, baseUrl).href);
    } catch {
      $(element).removeAttr("href");
    }
  });
  $("img[src]").each((_, element) => {
    const src = $(element).attr("src");
    if (!src) return;
    try {
      $(element).attr("src", new URL(src, baseUrl).href);
    } catch {
      $(element).removeAttr("src");
    }
  });
  const candidates = ["main", "article", "[role='main']", "#main-content", ".markdown-body", ".content", "body"];
  const selected = candidates.map((selector) => $(selector).first()).find((element) => element.length > 0);
  const body = selected?.html() ?? $.root().html() ?? "";
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  turndown.use(gfm);
  turndown.remove(["script", "style", "noscript"]);
  const markdown = turndown.turndown(body).replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
  return { title: title || "未命名网页", markdown };
}
