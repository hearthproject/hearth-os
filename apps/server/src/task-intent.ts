const SCREENSHOT_HINTS = /(截图|截屏|屏幕快照|screenshot|capture\s+(?:the\s+)?screen)/i;
const SCREENSHOT_PHRASE = /截.{0,8}(桌面|屏幕)/;
const GITHUB_HINTS = /(github|pull\s*request|\bPRs?\b|拉取请求)/i;
const PUBLIC_RESEARCH_HINTS = /(联网|上网|搜索|检索|调研|研究|公开资料|最新消息|最新进展|web\s*search|research|browse|look\s*up|latest\s+news)/i;
const CODE_EXECUTION_HINTS = /(仓库|代码|源码|补丁|单元测试|回归测试|运行测试|测试命令|\bnpm\s+test\b|\bpytest\b|构建失败|编译失败|CI\s*日志|api\s*契约|\brepo(?:sitory)?\b|\bcodebase\b|\bunit\s+tests?\b|\brun\s+tests?\b)/i;
export const GITHUB_NETWORK_HOSTS = ["github.com", "api.github.com"];

export function wantsScreenshot(text: string): boolean {
  return SCREENSHOT_HINTS.test(text) || SCREENSHOT_PHRASE.test(text);
}

export function wantsGithubAccess(text: string): boolean {
  return GITHUB_HINTS.test(text);
}

export function wantsPublicWebResearch(text: string): boolean {
  return PUBLIC_RESEARCH_HINTS.test(text);
}

export function wantsCodeExecution(text: string): boolean {
  return CODE_EXECUTION_HINTS.test(text);
}

const PR_ACTION_HINTS = /(审核|评审|review|列出|处理|回复|修改|rebase|关闭|合并|merge)/i;

export function needsGithubRepository(text: string): boolean {
  const hasPullRequest = /\bPRs?\b|pull\s*request|拉取请求/i.test(text);
  return hasPullRequest && PR_ACTION_HINTS.test(text);
}
