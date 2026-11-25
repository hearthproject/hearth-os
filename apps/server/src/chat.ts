import { isSimpleDraft } from "./draft-intent.ts";
import { completeChat, type ChatMessage } from "./model-client.ts";
import type { ModelSettings } from "./model-settings.ts";
import { GITHUB_NETWORK_HOSTS, needsGithubRepository, wantsDirectFileRead, wantsGithubAccess, wantsScreenshot, wantsSkillInstall } from "./task-intent.ts";
import { composePromptLayout, sharedAnswerContractPrompt } from "@hearth/agent-runtime";
import type { ExecutorId } from "@hearth/core";

export type ChatAction = "chat" | "task";

export interface ChatRoute {
  action: ChatAction;
  title: string;
  goal: string;
  reason: string;
}

export type ExecutionCapability = "github" | "desktop-capture";

export interface ExecutionPlan {
  taskKind: "general" | "workspace";
  expectedOutputs: string[];
  capability?: ExecutionCapability;
  networkHosts?: string[];
}

const CODE_HINTS = /(代码|仓库|项目里|这个项目|工程|git|commit|分支|测试|编译|构建|部署|重构|修复|bug|issue|pull request|typescript|javascript|python|npm|pnpm|依赖|数据库迁移|脚本)/i;

export function planExecution(message: string): ExecutionPlan {
  if (wantsDirectFileRead(message) || wantsSkillInstall(message)) {
    return { taskKind: "general", expectedOutputs: [] };
  }
  if (wantsScreenshot(message)) {
    return {
      taskKind: "general",
      expectedOutputs: ["desktop.png"],
      capability: "desktop-capture"
    };
  }
  if (wantsGithubAccess(message)) {
    return {
      taskKind: "workspace",
      expectedOutputs: [],
      capability: "github",
      networkHosts: [...GITHUB_NETWORK_HOSTS]
    };
  }
  if (CODE_HINTS.test(message)) return { taskKind: "workspace", expectedOutputs: [] };
  return { taskKind: "general", expectedOutputs: [] };
}

const TASK_KEYWORDS = [
  "帮我", "替我", "给我做", "生成", "制作", "写一份", "写个", "写一个", "整理", "汇总", "调研", "分析",
  "修复", "实现", "开发", "部署", "安装", "配置", "改造", "重构", "测试", "检查一下", "审查", "优化",
  "下载", "导出", "导入", "转换", "翻译文件", "发送", "发邮件", "创建文件", "修改文件", "做一个",
  "做一份", "跑一下", "运行", "自动化", "定时", "抓取", "爬取", "总结这", "整理这", "处理这"
];

export async function decideRoute(
  message: string,
  hasAttachments: boolean,
  url: string | null,
  settings: ModelSettings,
  options: { preferredExecutorId?: ExecutorId | null } = {}
): Promise<ChatRoute> {
  if (!hasAttachments && !url && isSimpleDraft(message)) return { action: "chat", title: "", goal: message, reason: "直接拟稿，无需工具执行" };
  if (hasAttachments) {
    return {
      action: "task",
      title: conversationTitle(message),
      goal: message,
      reason: "消息带有附件，已交给执行器读取处理"
    };
  }
  const deterministic = deterministicRoute(message);
  if (deterministic) return deterministic;
  const material = [
    hasAttachments ? "消息带有附件" : "",
    url ? "消息带有网址：" + url : ""
  ].filter(Boolean).join("；");

  if (!settings.apiKey || !settings.baseUrl || !settings.model) {
    return forcedTaskRoute(message, options.preferredExecutorId ?? null) ?? heuristicRoute(message);
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "你是 Hearth 的意图路由器，只做判断，不回答问题。",
        ...(options.preferredExecutorId
          ? ["用户已在输入框选择了执行器 " + options.preferredExecutorId + "。这表示执行类请求应交给该执行器，但普通知识问答仍然选择 chat。"]
          : []),
        "判断用户这句话要的是“回答”还是“执行”：",
        "- chat：介绍、解释、总结性提问、评价、比较、咨询、闲聊，以及任何只需要用文字回答的请求。即使用户贴了网址或附件，只要他是在问“这是什么/怎么样/为什么/介绍一下”，也选 chat。",
        "- task：当用户明确要求读取材料后产出交付物、生成或修改文件、运行命令、抓取网页并整理成结果，或要求审核/列出/回复/关闭/合并 GitHub 仓库或 PR 时，选 task。",
        "网址或附件只是上下文，不等于任务。判断标准是用户要的是解释，还是一个新的产物。",
        "示例：",
        "- “介绍一下这个 GitHub 项目，根据实际代码告诉我 https://…” → chat",
        "- “帮我总结这个网页并保存成 summary.md https://…” → task",
        "- “审核我的仓库里开着的 PR，列出需要回复或 rebase 的” → task",
        "- “PR 审核一般看什么” → chat",
        "只输出一个 JSON 对象，不要 Markdown，不要代码块：",
        "{\"action\":\"chat\"|\"task\",\"title\":\"任务标题，最多20字\",\"reason\":\"一句话原因\"}",
        "如果选择 chat，title 填空字符串。"
      ].join("\n")
    },
    {
      role: "user",
      content: material ? message + "\n\n[上下文] " + material : message
    }
  ];
  try {
    const result = await completeChat(settings, messages, { maxTokens: 160, temperature: 0, timeoutMs: 20_000 });
    const parsed = parseRouteJson(result.content);
    if (!parsed) return heuristicRoute(message, "路由器没有返回可用结果，已按关键词判断");
    if (parsed.action === "task" && (hasAttachments || url) && shouldAnswerInChat(message)) {
      return { action: "chat", title: "", goal: message, reason: "用户在询问材料内容，直接由聊天模型回答" };
    }
    if (parsed.action === "chat") {
      const forced = forcedTaskRoute(message, options.preferredExecutorId ?? null);
      if (forced) return forced;
    }
    return { ...parsed, goal: message };
  } catch {
    return forcedTaskRoute(message, options.preferredExecutorId ?? null)
      ?? heuristicRoute(message, "聊天模型暂时不可用，已按关键词判断");
  }
}

function deterministicRoute(message: string): ChatRoute | null {
  if (hasExplicitTaskAction(message)) {
    return { action: "task", title: conversationTitle(message), goal: message, reason: "明确要求实际执行，无需调用路由模型" };
  }
  if (isExplanationRequest(message)) {
    return { action: "chat", title: "", goal: message, reason: "明确要求解释或回答，无需调用路由模型" };
  }
  return null;
}

const TASK_ACTION_VERBS = [
  "读取", "写入", "保存", "发送", "下载", "导出", "导入", "创建", "修改", "改成", "改为", "删除",
  "运行", "执行", "提交", "部署", "安装", "抓取", "爬取", "整理", "汇总", "写成", "做成", "修复",
  "重构", "实现", "审核", "检查", "列出", "生成", "对齐", "同步", "拉取", "推送", "合并", "迁移",
  "更新", "克隆", "切换", "总结", "压缩", "复制", "移动", "重命名", "校验", "测试", "格式化", "翻译"
].join("|");
const POLITE_PREFIX = "(?:请|帮我|替我|给我|直接|立即|马上|去|先)";
const TASK_VERB = `(?:${TASK_ACTION_VERBS})`;
const QUESTION_ABOUT_ACTION = /(怎么|怎样|如何|为什么|为啥|什么是|是什么意思|什么意思|是否|吗|？|\?|会影响|影响什么|有什么影响|会怎样|会不会|会导致|后果|怎么办|什么原因)/;

/**
 * Only treat a message as an executable task when it asks to perform a real
 * action and does not merely ask about the action's meaning or consequence.
 * Compound requests such as "align the repo, then introduce it" still count.
 */
function hasExplicitTaskAction(message: string): boolean {
  const text = message.trim();
  if (!text || QUESTION_ABOUT_ACTION.test(text)) return false;
  if (new RegExp(`^${POLITE_PREFIX}?\\s*${TASK_VERB}`).test(text)) return true;
  if (new RegExp(`^${POLITE_PREFIX}?\\s*(?:把|将)[^，。；\\n]{0,120}${TASK_VERB}`).test(text)) return true;
  return new RegExp(`${POLITE_PREFIX}[^，。；\\n]{0,40}${TASK_VERB}`).test(text);
}

function forcedTaskRoute(message: string, preferredExecutorId: ExecutorId | null): ChatRoute | null {
  if (isExplanationRequest(message)) return null;
  if (wantsScreenshot(message)) {
    return {
      action: "task",
      title: conversationTitle(message),
      goal: message,
      reason: "需要桌面操作，已按任务派发"
    };
  }
  const referencesOwnRepository = /(我的|仓库|repo|https?:\/\/|目前|当前|这些|这个)/i.test(message);
  if (needsGithubRepository(message) && referencesOwnRepository) {
    return {
      action: "task",
      title: conversationTitle(message),
      goal: message,
      reason: "需要读取 GitHub 仓库或 PR，已按任务派发"
    };
  }
  if (preferredExecutorId) {
    const heuristic = heuristicRoute(message);
    if (heuristic.action === "task") {
      return { ...heuristic, reason: "用户已选择执行器，已按执行类请求派发任务" };
    }
  }
  return null;
}

function shouldAnswerInChat(message: string): boolean {
  const asksForExplanation = /(介绍|解释|说明|是什么|做什么|干什么|怎么样|怎么用|怎么|如何|为什么|为啥|怎么办|讲讲|说说|了解一下|看一下|看看|评价|对比|区别|架构|原理|特点|告诉我|一般|通常|最佳实践|看什么|注意什么|会影响|影响什么|有什么影响|会怎样|会不会|会导致|后果|什么原因|什么意思)/.test(message);
  if (!asksForExplanation) return false;
  // An explicit imperative ("帮我修复...并解释") still belongs to the task
  // path; a bare mention of the action ("修改这段代码会影响什么") does not.
  return !new RegExp(`^${POLITE_PREFIX}\\s*${TASK_VERB}`).test(message.trim());
}

function isExplanationRequest(message: string): boolean {
  const trimmed = message.trim();
  const leadingQuestion = /^(怎么|怎样|如何|为什么|为啥|什么是|请问|能不能|可以怎么|该怎么)/.test(trimmed);
  const imperative = /^(帮我|请帮我|替我|给我|直接|去)/.test(trimmed);
  return (leadingQuestion && !imperative) || shouldAnswerInChat(trimmed);
}

export function heuristicRoute(message: string, reason = "包含执行类指令，交给任务执行器"): ChatRoute {
  if (isSimpleDraft(message)) return { action: "chat", title: "", goal: message, reason: "直接拟稿，无需工具执行" };
  if (hasExplicitTaskAction(message)) {
    return { action: "task", title: conversationTitle(message), goal: message, reason };
  }
  const normalized = message.trim().toLowerCase();
  if (isExplanationRequest(message)) {
    return { action: "chat", title: "", goal: message, reason: "询问方法或解释，直接由聊天模型回答" };
  }
  const looksLikeTask = TASK_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
  if (!looksLikeTask) {
    return { action: "chat", title: "", goal: message, reason: "普通对话，直接由聊天模型回答" };
  }
  return {
    action: "task",
    title: conversationTitle(message),
    goal: message,
    reason
  };
}

export function conversationTitle(message: string): string {
  const clean = message
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:请帮我|麻烦你?|请|帮我|替我|给我|我想|我需要|需要你|能不能|可以帮我|你可以|你能)\s*/u, "")
    .replace(/^[，,。.、:：\s]+/, "")
    .replace(/[。.!！?？\s]+$/u, "");
  if (!clean) return "新对话";
  return clean.length > 24 ? `${clean.slice(0, 24)}…` : clean;
}

function cleanGeneratedTitle(value: string): string {
  const firstLine = value
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  const clean = firstLine
    .replace(/^["'“”‘’《》【】#*\s]+/u, "")
    .replace(/["'“”‘’《》【】#*\s]+$/u, "")
    .replace(/[。.!！?？:：；;，,、\s]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || /^(新对话|新任务|对话|会话|问题|任务)$/u.test(clean)) return "";
  return clean.length > 18 ? `${clean.slice(0, 18)}…` : clean;
}

export function chatSystemPrompt(dynamicBlocks: string[] = []): string {
  const layout = composePromptLayout([
    { id: "identity", content: "你是 Hearth，一个运行在用户本机的个人助手。回答使用简体中文，直接、清楚、可执行。" },
    { id: "answer", content: sharedAnswerContractPrompt },
    { id: "chat", content: "普通问题直接回答，不要假装已经执行了操作。需要实际执行时，用户可以直接说出任务。无法读取网址或附件内容时明确说明限制，不要编造。" },
    ...dynamicBlocks.map((content, index) => ({ id: `context-${index + 1}`, content, dynamic: true }))
  ]);
  return layout.text;
}

export function conversationTitleFromRoute(route: ChatRoute, message: string): string {
  return cleanGeneratedTitle(route.title) || conversationTitle(message);
}

function parseRouteJson(text: string): { action: ChatAction; title: string; reason: string } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const action = parsed.action === "task" ? "task" : parsed.action === "chat" ? "chat" : null;
    if (!action) return null;
    const title = typeof parsed.title === "string" ? parsed.title.trim().slice(0, 30) : "";
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 120) : "";
    return { action, title: action === "task" ? title || "新任务" : "", reason };
  } catch {
    return null;
  }
}
