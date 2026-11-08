import type { FeishuInboundMessage } from "./feishu.ts";

export function parseFeishuMessage(data: unknown): FeishuInboundMessage | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const message = record.message && typeof record.message === "object" ? record.message as Record<string, unknown> : null;
  const sender = record.sender && typeof record.sender === "object" ? record.sender as Record<string, unknown> : null;
  if (!message || !sender) return null;
  if (sender.sender_type !== undefined && sender.sender_type !== "user") return null;

  const senderId = sender.sender_id && typeof sender.sender_id === "object" ? sender.sender_id as Record<string, unknown> : null;
  const openId = typeof senderId?.open_id === "string" ? senderId.open_id : null;
  const messageId = typeof message.message_id === "string" ? message.message_id : null;
  const chatId = typeof message.chat_id === "string" ? message.chat_id : null;
  const messageType = typeof message.message_type === "string" ? message.message_type : "unknown";
  if (!openId || !messageId || !chatId) return null;

  const chatType = message.chat_type === "p2p" ? "p2p" : "group";
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  if (chatType === "group" && mentions.length === 0) return null;

  let content: Record<string, unknown> = {};
  if (typeof message.content === "string") {
    try {
      const parsed = JSON.parse(message.content) as unknown;
      if (parsed && typeof parsed === "object") content = parsed as Record<string, unknown>;
    } catch {
      content = {};
    }
  }

  const rawText = typeof content.text === "string" ? content.text : "";
  const text = rawText.replace(/@_user_\d+/g, "").replace(/\s+/g, " ").trim();
  const fileKey = typeof content.file_key === "string" ? content.file_key : null;
  const imageKey = typeof content.image_key === "string" ? content.image_key : null;
  const fileName = typeof content.file_name === "string" ? content.file_name : null;

  return {
    messageId,
    chatId,
    chatType,
    senderOpenId: openId,
    messageType,
    text,
    imageKey,
    fileKey,
    fileName,
    createdAt: new Date().toISOString()
  };
}