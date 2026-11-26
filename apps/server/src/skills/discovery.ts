const GITHUB_API = "https://api.github.com";

export interface SkillCandidate {
  repo: string;
  source: string;
  skillPath: string | null;
  ref: string | null;
  description: string;
}

export class SkillDiscoveryError extends Error {
  readonly code = "SKILL_DISCOVERY_FAILED";
  readonly statusCode = 502;

  constructor(message: string) {
    super(message);
    this.name = "SkillDiscoveryError";
  }
}

/**
 * 在 GitHub 上按关键词寻找包含 SKILL.md 的仓库。
 * 与 install_skill 工具共用同一套发现逻辑，保证 `/skill` 面板与一句话安装结果一致。
 */
export async function discoverSkillSources(query: string): Promise<SkillCandidate[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const response = await githubFetch(`/search/repositories?q=${encodeURIComponent(trimmed)}&per_page=10&sort=stars&order=desc`);
  const data = response as { items?: Array<{
    full_name?: string;
    html_url?: string;
    description?: string | null;
    default_branch?: string;
  }> };
  const items = data.items ?? [];
  const candidates: SkillCandidate[] = [];
  for (const item of items.slice(0, 8)) {
    const fullName = item.full_name ?? "";
    const branch = item.default_branch ?? "main";
    if (!fullName) continue;
    const skillPath = await findSkillPath(fullName, branch);
    if (skillPath === undefined) continue;
    const directory = skillPath === null ? "" : skillPath.replace(/\/?SKILL\.md$/i, "");
    candidates.push({
      repo: fullName,
      source: directory
        ? `${item.html_url ?? `https://github.com/${fullName}`}/tree/${branch}/${directory}`
        : (item.html_url ?? `https://github.com/${fullName}`),
      skillPath,
      ref: branch,
      description: item.description ?? ""
    });
  }
  return candidates;
}

async function findSkillPath(repo: string, branch: string): Promise<string | null | undefined> {
  const tree = await githubFetch(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`) as {
    tree?: Array<{ path?: string; type?: string }>;
  };
  const paths = (tree.tree ?? [])
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string" && /(^|\/)SKILL\.md$/i.test(entry.path))
    .map((entry) => entry.path!)
    .sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length);
  if (paths.length === 0) return undefined;
  return paths[0] === "SKILL.md" ? null : paths[0]!;
}

async function githubFetch(path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "hearth-skill-installer",
        ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
      },
      signal: AbortSignal.timeout(20_000)
    });
  } catch (error) {
    throw new SkillDiscoveryError(`GitHub 无法访问：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new SkillDiscoveryError(`GitHub 搜索失败：HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}
