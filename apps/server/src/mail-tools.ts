import { z } from "zod";
import type { AgentTool } from "@hearth/agent-runtime";
import type { EmailService } from "./email.ts";
import type { OutboxService } from "./outbox.ts";

const inputSchema = z.object({
  accountId: z.string().min(1),
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(200_000)
}).strict();

export function createMailTools(mail: EmailService, outbox: OutboxService): AgentTool[] {
  // A repeated model call in this run must reuse the same approval, not send twice.
  const prepared = new Map<string, string>();
  return [{
    definition: {
      name: "list_mail_accounts",
      description: "列出 Hearth 已连接的发件账户（不含密钥）。没有账户时请用户到 /mail 添加 Gmail 或其他邮箱。",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    },
    async execute() {
      return { content: JSON.stringify(mail.list().map(({ id, name, fromAddress }) => ({ id, name, fromAddress }))) };
    }
  }, {
    definition: {
      name: "prepare_email",
      description: "用户要求发邮件时，准备邮件并生成发送审批，不会立即发送。先查询发件账户；不得猜测收件地址，缺失时询问用户。返回审批链接后停止，不要声称已发送，不要再用 shell 或网络工具发信。仅要求拟信时直接回复正文，无需调用此工具。",
      parameters: {
        type: "object",
        properties: {
          accountId: { type: "string" },
          to: { type: "array", items: { type: "string" } },
          cc: { type: "array", items: { type: "string" } },
          bcc: { type: "array", items: { type: "string" } },
          subject: { type: "string" }, body: { type: "string" }
        },
        required: ["accountId", "to", "subject", "body"], additionalProperties: false
      }
    },
    async execute(input) {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) return { content: "邮件参数不完整或地址无效，请补齐发件账户、收件地址、主题和正文。", isError: true };
      const { accountId, ...message } = parsed.data;
      if (!mail.list().some((account) => account.id === accountId)) return { content: "发件账户不存在，请先在 /mail 连接邮箱。", isError: true };
      const key = JSON.stringify(parsed.data);
      try {
        let id = prepared.get(key);
        if (!id) {
          id = outbox.create({ ...message, account: `smtp:${accountId}` }).id;
          prepared.set(key, id);
        }
        const current = outbox.get(id);
        const draft = current.status === "draft" ? (await outbox.submit(id)).draft : current;
        const url = draft.taskId ? `/tasks/${draft.taskId}` : "/outbox";
        const summary = `邮件已准备，尚未确认发送。[查看邮件并确认发送](${url})`;
        return { action: "finish", summary, content: JSON.stringify({ draftId: id, status: draft.status, url, message: summary }) };
      } catch (error) {
        return { content: error instanceof Error ? error.message : "邮件准备失败", isError: true };
      }
    }
  }];
}
