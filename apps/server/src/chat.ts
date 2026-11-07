import { completeChat, type ChatMessage } from "./model-client.ts";
import type { ModelSettings } from "./model-settings.ts";
import { wantsGithubAccess, wantsScreenshot } from "./task-intent.ts";

export type ChatAction = "chat" | "task";

export interface ChatRoute {
  action: ChatAction;
  title: string;
  goal: string;
  reason: string;
}

export type ExecutionCapability = "github" | "desktop-capture";

export interface ExecutionPlan {
  executorId: "native" | "codex" | "hermes";
  taskKind: "general" | "workspace";
  expectedOutputs: string[];
  capability?: ExecutionCapability;
}

const CODE_HINTS = /(代码|仓库|项目里|这个项目|工程|git|commit|分支|测试|编译|构建|部署|重构|修复|bug|issue|pull request|typescript|javascript|python|npm|pnpm|依赖|数据库迁移|脚本)/i;

export function planExecution(message: string): ExecutionPlan {
  if (wantsScreenshot(message)) {
    return {
      executorId: "native",
      taskKind: "general",
      expectedOutputs: ["desktop.png"],
      capability: "desktop-capture"
    };
  }
  if (wantsGithubAccess(message)) {
    return { executorId: "codex", taskKind: "workspace", expectedOutputs: ["result.md"], capability: "github" };
  }
  if (CODE_HINTS.test(message)) {
    return { executorId: "codex", taskKind: "workspace", expectedOutputs: ["result.md"] };
  }
  return { executorId: "native", taskKind: "general", expectedOutputs: ["result.md"] };
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
  settings: ModelSettings
): Promise<ChatRoute> {
  const material = [
    hasAttachments ? "消息带有附件" : "",
    url ? "消息带有网址：" + url : ""
  ].filter(Boolean).join("；");

  if (!settings.apiKey || !settings.baseUrl || !settings.model) {
    return heuristicRoute(message);
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "你是 Hearth 的意图路由器，只做判断，不回答问题。",
        "判断用户这句话要的是“回答”还是“执行”：",
        "- chat：介绍、解释、总结性提问、评价、比较、咨询、闲聊，以及任何只需要用文字回答的请求。即使用户贴了网址或附件，只要他是在问“这是什么/怎么样/为什么/介绍一下”，也选 chat。",
        "- task：只有当用户明确要求读取材料后产出交付物、生成或修改文件、运行命令、抓取网页并整理成结果时，才选 task。",
        "网址或附件只是上下文，不等于任务。判断标准是用户要的是解释，还是一个新的产物。",
        "示例：",
        "- “介绍一下这个 GitHub 项目，根据实际代码告诉我 https://…” → chat",
        "- “帮我总结这个网页并保存成 summary.md https://…” → task",
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
    return { ...parsed, goal: message };
  } catch {
    return heuristicRoute(message, "聊天模型暂时不可用，已按关键词判断");
  }
}

function shouldAnswerInChat(message: string): boolean {
  const asksForExplanation = /(介绍|是什么|做什么|干什么|怎么样|怎么用|如何|为什么|讲讲|说说|了解一下|看一下|看看|评价|对比|区别|架构|原理|特点|告诉我)/.test(message);
  const asksForAction = /(保存|生成|写入|修改|创建|删除|导出|下载|抓取|爬取|整理成|汇总成|写成|做成|发给我|输出到|放到|修复|重构|实现|部署|安装|帮我做|帮我写|帮我整理|帮我总结|帮我分析|帮我查)/.test(message) || /(帮我|请|直接|去)\s*(运行|执行|跑)/.test(message);
  return asksForExplanation && !asksForAction;
}

export function heuristicRoute(message: string, reason = "包含执行类指令，交给任务执行器"): ChatRoute {
  const normalized = message.trim().toLowerCase();
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
  const clean = message.replace(/\s+/g, " ").trim();
  if (!clean) return "新对话";
  return clean.length > 22 ? `${clean.slice(0, 22)}…` : clean;
}

export function chatSystemPrompt(): string {
  return [
    "你是 Hearth，一个运行在用户本机的个人助手。",
    "回答使用简体中文，直接、清楚、可执行。",
    "普通问题直接回答，不要假装已经执行了操作；需要实际执行时提醒用户可以在对话框里直接说出任务。",
    "如果用户提供了网址但你无法读取其内容，要明确说明限制，不要编造页面或代码内容。",
    "可以使用 Markdown，但不要输出无关的前言或客套话。"
  ].join("\n");
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
