const SCREENSHOT_HINTS = /(截图|截屏|屏幕快照|screenshot|capture\s+(?:the\s+)?screen)/i;
const SCREENSHOT_PHRASE = /截.{0,8}(桌面|屏幕)/;
const GITHUB_HINTS = /(github|pull\s*request|\bPRs?\b|拉取请求)/i;

export function wantsScreenshot(text: string): boolean {
  return SCREENSHOT_HINTS.test(text) || SCREENSHOT_PHRASE.test(text);
}

export function wantsGithubAccess(text: string): boolean {
  return GITHUB_HINTS.test(text);
}

const PR_ACTION_HINTS = /(审核|评审|review|列出|处理|回复|修改|rebase|关闭|合并|merge)/i;

export function needsGithubRepository(text: string): boolean {
  const hasPullRequest = /\bPRs?\b|pull\s*request|拉取请求/i.test(text);
  return hasPullRequest && PR_ACTION_HINTS.test(text);
}

export class CapabilityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityUnavailableError";
  }
}
