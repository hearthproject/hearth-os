export type FilePreviewKind = "markdown" | "image" | "pdf" | "text" | "binary";

export const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;

const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;
const PDF_EXT = /\.pdf$/i;
const TEXT_EXT = /\.(txt|text|md|markdown|mdx|json|jsonl|ndjson|csv|tsv|log|ya?ml|toml|ini|cfg|conf|properties|ts|tsx|js|jsx|mjs|cjs|css|scss|sass|less|html?|xml|sql|py|rb|go|rs|java|kt|kts|swift|sh|bash|zsh|ps1|bat|cmd|c|h|cc|cpp|hpp|cs|php|lua|env|dockerfile|gitignore|editorconfig)$/i;

export function previewKind(name: string, mimeType: string): FilePreviewKind {
  const mime = mimeType.toLowerCase();
  const file = name.toLowerCase();
  if (PDF_EXT.test(file) || mime === "application/pdf") return "pdf";
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
