import { describe, expect, it } from "vitest";
import { isMailDraftReply, parseMailDraft } from "../../web/src/lib/mail-draft.ts";
import { mailConnectionError, normalizeMailPassword } from "./email.ts";
import { isDraftRevision } from "./draft-intent.ts";

describe("chat mail drafts", () => {
  it("keeps the send card for short formatting follow-ups and existing subject/body replies", () => {
    const content = "主题：12月初回国\n\n妈：\n\n我12月初就回国了。\n\n祝好\n小兰\n\n需要我直接帮你把日期和署名补成具体内容吗？告诉我发件用的名字就行。";
    const messages = [{ role: "user", content: "邮件格式" }, { role: "assistant", content }];
    expect(isMailDraftReply(messages, 1)).toBe(true);
    expect(isMailDraftReply([{ role: "assistant", content }], 0)).toBe(true);
    expect(parseMailDraft(content).body).toBe("妈：\n\n我12月初就回国了。\n\n祝好\n小兰");
    expect(isDraftRevision("邮件格式")).toBe(true);
    expect(isDraftRevision("正常语气就好了")).toBe(true);
    expect(isDraftRevision("发送邮件给老师")).toBe(false);
    expect(isDraftRevision("再加一句 这是由Hearth agent发送的邮件！")).toBe(true);
    expect(isDraftRevision("再加一句谢谢，然后发送给老师")).toBe(false);
  });
  it("extracts older letter replies without sending the surrounding advice", () => {
    expect(parseMailDraft("复制即可：\n---\n**主题：请假申请**\n\n老师您好：\n我感冒了。\n---\n发送前修改姓名。"))
      .toEqual({ subject: "请假申请", body: "老师您好：\n我感冒了。" });
    expect(parseMailDraft("Subject: Leave request\n\nDear teacher,"))
      .toEqual({ subject: "Leave request", body: "Dear teacher," });
  });
  it("recognizes draft revisions but not unrelated following conversation", () => {
    const messages = [{ role: "user", content: "帮我拟一封请假信" }, { role: "assistant", content: "草稿" }, { role: "user", content: "我叫小兰" }];
    expect(isMailDraftReply(messages, 3)).toBe(true);
    expect(isMailDraftReply([...messages, { role: "user", content: "解释什么是 ontology" }], 4)).toBe(false);
  });
  it("normalizes only Gmail credentials and explains authentication failures", () => {
    expect(normalizeMailPassword("smtp.gmail.com", "abcd efgh ijkl mnop")).toBe("abcdefghijklmnop");
    expect(normalizeMailPassword("smtp.example.com", "pass word")).toBe("pass word");
    expect(mailConnectionError("smtp.gmail.com", new Error("535 5.7.8 BadCredentials"))).toContain("应用专用密码");
    expect(mailConnectionError("smtp.gmail.com", new Error("ETIMEDOUT"))).toBe("ETIMEDOUT");
  });
});
