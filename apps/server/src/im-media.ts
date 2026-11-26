import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { ChatAttachment } from "@hearth/core";
import { unzipSync, zipSync } from "fflate";
import { Jimp } from "jimp";

/** WeChat's iLink file message hard limit (measured against the live gateway). */
export const WECHAT_MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Leave a small margin so multipart/encryption overhead never pushes us over. */
const WECHAT_FILE_SAFETY_BYTES = 512 * 1024;

const SHRINKABLE_EXTENSIONS = new Set([".pptx", ".docx", ".xlsx"]);
const IMAGE_EXTENSION = /\.(png|bmp|tiff?)$/i;
const MIN_IMAGE_BYTES = 200 * 1024;
const MAX_IMAGE_EDGE = 1600;

export interface PreparedImAttachment {
  attachment: ChatAttachment;
  /** Original display name before any WeChat-specific shrinking. */
  originalName: string;
  originalBytes: number;
  compressed: boolean;
  note: string | null;
}

export interface PrepareImAttachmentsResult {
  items: PreparedImAttachment[];
  failures: string[];
}

function mimeTypeForName(name: string): string {
  const extension = extname(name).toLowerCase();
  const office: Record<string, string> = {
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  };
  return office[extension] ?? "application/octet-stream";
}

function safeBaseName(value: string): string {
  const raw = basename(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return raw && raw !== "." && raw !== ".." ? raw : "file";
}

function storePreparedBuffer(buffer: Buffer, name: string, attachmentRoot: string): ChatAttachment {
  mkdirSync(attachmentRoot, { recursive: true });
  const safeName = safeBaseName(name).slice(0, 200);
  const extension = extname(safeName).toLowerCase();
  const safeExtension = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
  const id = randomUUID();
  writeFileSync(join(attachmentRoot, `${id}${safeExtension}`), buffer, { flag: "wx" });
  return {
    id,
    name: safeName,
    mimeType: mimeTypeForName(safeName),
    bytes: buffer.byteLength
  };
}

/**
 * Re-encode embedded raster images so an Office archive drops below the WeChat
 * file ceiling while keeping the page/slide count and layout untouched.
 *
 * PPTX/DOCX/XLSX are ZIP containers. We rename image1.png -> image1.jpg and
 * rewrite every relationship + [Content_Types].xml reference, which is the
 * OOXML-correct way to swap media (the XML itself only points at relationship
 * ids, never at file extensions).
 */
export async function shrinkOfficeArchive(
  input: Buffer,
  fileName: string,
  maxBytes = WECHAT_MAX_FILE_BYTES - WECHAT_FILE_SAFETY_BYTES
): Promise<Buffer> {
  const extension = extname(fileName).toLowerCase();
  if (!SHRINKABLE_EXTENSIONS.has(extension)) throw new Error(`不支持压缩 ${extension || "该"} 文件`);
  const files = unzipSync(input);
  const renamed = new Map<string, string>();
  let changed = false;

  for (const [name, data] of Object.entries(files)) {
    if (!/^(?:ppt|word|xl)\/(?:[^/]+\/)?media\//.test(name)) continue;
    if (!IMAGE_EXTENSION.test(name)) continue;
    if (data.byteLength < MIN_IMAGE_BYTES) continue;
    try {
      const image = await Jimp.fromBuffer(Buffer.from(data));
      if (image.bitmap.width > MAX_IMAGE_EDGE || image.bitmap.height > MAX_IMAGE_EDGE) {
        image.scaleToFit({ w: MAX_IMAGE_EDGE, h: MAX_IMAGE_EDGE });
      }
      const jpeg = await image.getBuffer("image/jpeg", { quality: 82 });
      if (jpeg.byteLength >= data.byteLength * 0.8) continue;
      const nextName = name.replace(IMAGE_EXTENSION, ".jpg");
      files[nextName] = new Uint8Array(jpeg);
      delete files[name];
      renamed.set(name, nextName);
      changed = true;
    } catch {
      // A corrupt/unsupported image is left alone; other images may still shrink.
    }
  }

  if (!changed) throw new Error("文件里没有可压缩的图片");

  for (const [name, data] of Object.entries(files)) {
    if (!name.endsWith(".rels") && name !== "[Content_Types].xml") continue;
    let text = Buffer.from(data).toString("utf8");
    let touched = false;
    for (const [from, to] of renamed) {
      const fromBase = from.split("/").pop() ?? from;
      const toBase = to.split("/").pop() ?? to;
      if (!text.includes(fromBase)) continue;
      text = text.split(fromBase).join(toBase);
      touched = true;
    }
    if (touched) files[name] = new Uint8Array(Buffer.from(text, "utf8"));
  }

  const contentTypes = files["[Content_Types].xml"];
  if (!contentTypes) throw new Error("Office 文件缺少 [Content_Types].xml");
  let types = Buffer.from(contentTypes).toString("utf8");
  if (!/Extension="jpg"/i.test(types)) {
    types = types.replace("</Types>", '<Default Extension="jpg" ContentType="image/jpeg"/></Types>');
    files["[Content_Types].xml"] = new Uint8Array(Buffer.from(types, "utf8"));
  }

  const archive = zipSync(files, { level: 6 });
  if (archive.byteLength > maxBytes) {
    throw new Error(`压缩后仍有 ${formatBytes(archive.byteLength)}，超过微信 ${formatBytes(maxBytes)} 上限`);
  }
  return Buffer.from(archive);
}

async function shrinkAttachmentToFile(
  path: string,
  name: string,
  attachmentRoot: string,
  maxBytes: number
): Promise<PreparedImAttachment> {
  const buffer = readFileSync(path);
  const originalBytes = buffer.byteLength;
  const extension = extname(name).toLowerCase();
  const base = name.slice(0, extension ? -extension.length : undefined);
  const outputName = `${base}-微信版${extension || ".zip"}`.slice(0, 180);
  const shrunk = await shrinkOfficeArchive(buffer, name, maxBytes);
  const attachment = storePreparedBuffer(Buffer.from(shrunk), outputName, attachmentRoot);
  return {
    attachment,
    originalName: name,
    originalBytes,
    compressed: true,
    note: `微信单文件上限 ${formatBytes(WECHAT_MAX_FILE_BYTES)}，原文件 ${formatBytes(originalBytes)}，已发送图片压缩版（页数、文字和版式不变）`
  };
}

/**
 * Prepare every attachment for an IM upload. Files at/under the limit pass
 * through untouched; oversized Office files are shrunk into a new attachment.
 * Unsupported oversized files are reported instead of silently dropped.
 */
export async function prepareImAttachments(
  attachments: ChatAttachment[],
  attachmentRoot: string,
  options: { maxBytes?: number; shrink?: boolean } = {}
): Promise<PrepareImAttachmentsResult> {
  const maxBytes = options.maxBytes ?? WECHAT_MAX_FILE_BYTES - WECHAT_FILE_SAFETY_BYTES;
  const shrink = options.shrink ?? true;
  const items: PreparedImAttachment[] = [];
  const failures: string[] = [];

  for (const attachment of attachments) {
    const path = findAttachmentPath(attachment.id, attachmentRoot);
    if (!path) {
      failures.push(`${attachment.name}：附件已失效`);
      continue;
    }
    let bytes = 0;
    try {
      bytes = statSync(path).size;
    } catch {
      failures.push(`${attachment.name}：附件不可读`);
      continue;
    }
    if (bytes <= maxBytes) {
      items.push({
        attachment,
        originalName: attachment.name,
        originalBytes: bytes,
        compressed: false,
        note: null
      });
      continue;
    }
    if (!shrink) {
      failures.push(`${attachment.name}：${formatBytes(bytes)} 超过 ${formatBytes(maxBytes)} 上限`);
      continue;
    }
    try {
      items.push(await shrinkAttachmentToFile(path, attachment.name, attachmentRoot, maxBytes));
    } catch (error) {
      failures.push(`${attachment.name}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { items, failures };
}

/** Bundle several prepared files into one ZIP so a turn still fits the message quota. */
export function bundlePreparedAttachments(
  items: PreparedImAttachment[],
  attachmentRoot: string,
  maxBytes = WECHAT_MAX_FILE_BYTES - WECHAT_FILE_SAFETY_BYTES
): PreparedImAttachment | null {
  if (items.length <= 1) return items[0] ?? null;
  const files: Record<string, Uint8Array> = {};
  for (const item of items) {
    const path = findAttachmentPath(item.attachment.id, attachmentRoot);
    if (!path) continue;
    files[item.attachment.name] = new Uint8Array(readFileSync(path));
  }
  const archive = zipSync(files, { level: 6 });
  if (archive.byteLength > maxBytes) return null;
  const attachment = storePreparedBuffer(Buffer.from(archive), `Hearth-文件-${new Date().toISOString().slice(0, 10)}.zip`, attachmentRoot);
  return {
    attachment,
    originalName: items.map((item) => item.originalName).join("、"),
    originalBytes: items.reduce((total, item) => total + item.originalBytes, 0),
    compressed: true,
    note: items.some((item) => item.compressed)
      ? "多个文件已打包为一个 ZIP；其中超出上限的 Office 文件已做图片压缩"
      : "多个文件已打包为一个 ZIP，方便一次接收"
  };
}

export function findAttachmentPath(id: string, attachmentRoot: string): string | null {
  const safe = id.replace(/[^0-9a-fA-F-]/g, "");
  if (safe !== id) return null;
  try {
    const file = readdirSync(attachmentRoot).find((name) => name.startsWith(`${safe}.`));
    if (!file) return null;
    const path = join(attachmentRoot, file);
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}
