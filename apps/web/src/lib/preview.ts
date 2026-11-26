export type FilePreviewKind = "markdown" | "image" | "pdf" | "text" | "binary" | "sheet" | "slides" | "doc" | "video" | "audio";

export const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
/** Office 预览需要把整个压缩包读进内存，限制在 40 MB 内。 */
export const OFFICE_PREVIEW_LIMIT = 40 * 1024 * 1024;

const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;
const PDF_EXT = /\.pdf$/i;
const SHEET_EXT = /\.(xlsx|csv|tsv)$/i;
const SLIDES_EXT = /\.pptx$/i;
const DOC_EXT = /\.docx$/i;
const VIDEO_EXT = /\.(mp4|webm|ogv|mov|m4v)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg)$/i;
const TEXT_EXT = /\.(txt|text|md|markdown|mdx|json|jsonl|ndjson|log|ya?ml|toml|ini|cfg|conf|properties|ts|tsx|js|jsx|mjs|cjs|css|scss|sass|less|html?|xml|sql|py|rb|go|rs|java|kt|kts|swift|sh|bash|zsh|ps1|bat|cmd|c|h|cc|cpp|hpp|cs|php|lua|env|dockerfile|gitignore|editorconfig)$/i;

export function previewKind(name: string, mimeType: string): FilePreviewKind {
  const mime = mimeType.toLowerCase();
  const file = name.toLowerCase();
  if (PDF_EXT.test(file) || mime === "application/pdf") return "pdf";
  if (SLIDES_EXT.test(file) || mime.includes("presentationml.presentation")) return "slides";
  if (SHEET_EXT.test(file) || mime.includes("spreadsheetml") || mime === "text/csv") return "sheet";
  if (DOC_EXT.test(file) || mime.includes("wordprocessingml")) return "doc";
  if (VIDEO_EXT.test(file) || mime.startsWith("video/")) return "video";
  if (AUDIO_EXT.test(file) || mime.startsWith("audio/")) return "audio";
  if (MARKDOWN_EXT.test(file) || mime.includes("markdown")) return "markdown";
  if (IMAGE_EXT.test(file) || (mime.startsWith("image/") && !mime.includes("svg"))) return "image";
  if (
    TEXT_EXT.test(file)
    || mime.startsWith("text/")
    || mime.includes("json")
    || mime === "application/xml"
    || mime === "text/xml"
    || mime.endsWith("+xml")
    || mime.includes("javascript")
    || mime.includes("yaml")
  ) return "text";
  return "binary";
}

export function fileExtension(name: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(name);
  return match?.[1]?.toUpperCase() ?? "FILE";
}
