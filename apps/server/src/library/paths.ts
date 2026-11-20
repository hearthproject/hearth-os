const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".venv",
  "__pycache__",
  "node_modules",
  "dist",
  "build"
]);

const EXCLUDED_FILE_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx|kdbx)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^master\.key$/i,
  /^credentials?(?:\.|$)/i,
  /^secrets?(?:\.|$)/i,
  /^cookies?(?:\.|$)/i,
  /^auth\.json$/i,
  /^wallet\.dat$/i
];

export function isSensitivePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.toLowerCase().split("/").filter(Boolean);
  if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) return true;
  if (segments.some((segment) => [".ssh", ".aws", ".azure", ".gnupg"].includes(segment))) return true;
  const name = segments.at(-1) ?? "";
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}
