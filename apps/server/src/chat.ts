import { completeChat, type ChatMessage } from "./model-client.ts";
import type { ModelSettings } from "./model-settings.ts";

export type ChatAction = "chat" | "task";

export interface ChatRoute {
  action: ChatAction;
  title: string;
  goal: string;
  reason: string;
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
  if (hasAttachments || url) {
    return {
      action: "task",
      title: conversationTitle(message) || "处理上传内容",
      goal: message,
      reason: hasAttachments ? "这条消息带有文件，交给任务执行器处理" : "这条消息带有网址，交给任务执行器抓取并处理"
    };
  }

  if (!settings.apiKey || !settings.baseUrl || !settings.model) return heuristicRoute(message);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "你是 Hearth 的任务路由器，只做判断，不回答问题。",
        "判断用户这句话应当由谁处理：",
        "- chat：闲聊、概念解释、简短问答、写作建议、不需要读取文件或执行操作的请求。",
        "- task：需要实际执行、检索资料、生成文件、处理附件、访问网址、修改代码、运行命令或产出交付物的请求。",
        "只输出一个 JSON 对象，不要 Markdown，不要代码块：",
        '{"action":"chat"|"task","title":"任务标题，最多20字","reason":"一句话原因"}',
        "如果选择 chat，title 填空字符串。"
      ].join("\n")
    },
    { role: "user", content: message }
  ];
  try {
    const result = await completeChat(settings, messages, { maxTokens: 160, temperature: 0, timeoutMs: 20_000 });
    const parsed = parseRouteJson(result.content);
    if (parsed) return { ...parsed, goal: message };
    return heuristicRoute(message, "路由器没有返回可用结果，已按关键词判断");
  } catch {
    return heuristicRoute(message, "聊天模型暂时不可用，已按关键词判断");
  }
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