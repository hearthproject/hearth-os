import { describe, expect, it } from "vitest";
import { getChatSelection, requestChat } from "./chat-selection.ts";

describe("chat project exit selection", () => {
  it("switches from a pending project chat to a standalone conversation", () => {
    requestChat(null, "project-1");
    expect(getChatSelection()).toMatchObject({
      conversationId: null,
      pendingProjectId: "project-1"
    });

    requestChat("standalone-conversation");
    expect(getChatSelection()).toMatchObject({
      conversationId: "standalone-conversation",
      pendingProjectId: null
    });
  });
});
