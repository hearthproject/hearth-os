import { describe, expect, it, vi } from "vitest";
import type { AgentToolContext } from "@hearth/agent-runtime";
import type { EmailService } from "./email.ts";
import type { OutboxService } from "./outbox.ts";
import { createMailTools } from "./mail-tools.ts";

function setup() {
  let draft = { id: "draft-1", status: "draft", taskId: null as string | null };
  const mail = { list: () => [{ id: "gmail-1", name: "Gmail", fromAddress: "me@gmail.com", smtp: { password: "secret" } }], send: vi.fn() };
  const outbox = {
    create: vi.fn(() => draft), get: vi.fn(() => draft),
    submit: vi.fn(async () => { draft = { ...draft, status: "pending_approval", taskId: "mail-task" }; return { draft }; })
  };
  const tools = createMailTools(mail as unknown as EmailService, outbox as unknown as OutboxService);
  return { tools, mail, outbox };
}
const context = {} as AgentToolContext;
const input = { accountId: "gmail-1", to: ["teacher@example.com"], subject: "Leave request", body: "I am unwell today." };

describe("mail agent tools", () => {
  it("exposes identity without credentials", async () => {
    const { tools } = setup();
    const result = await tools[0]!.execute({}, context);
    expect(result.content).toContain("me@gmail.com");
    expect(result.content).not.toContain("secret");
    expect(result.content).not.toContain("smtp");
  });
  it("creates one approval and stops without sending, including repeated calls", async () => {
    const { tools, mail, outbox } = setup();
    const result = await tools[1]!.execute(input, context);
    await tools[1]!.execute(input, context);
    expect(result.action).toBe("finish");
    expect(result.summary).toContain("/tasks/mail-task");
    expect(outbox.create).toHaveBeenCalledTimes(1);
    expect(outbox.submit).toHaveBeenCalledTimes(1);
    expect(mail.send).not.toHaveBeenCalled();
  });
  it("rejects missing recipients and nonexistent accounts before creating anything", async () => {
    const { tools, outbox } = setup();
    expect((await tools[1]!.execute({ ...input, to: [] }, context)).isError).toBe(true);
    expect((await tools[1]!.execute({ ...input, accountId: "unknown" }, context)).isError).toBe(true);
    expect(outbox.create).not.toHaveBeenCalled();
  });
});
