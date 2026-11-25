import { describe, expect, it, vi } from "vitest";
import { captureBrowserSnapshot } from "./browser-snapshot.ts";

function fakePage(text = "正文", elements = [
  { ref: "e1", role: "textbox", name: "邮箱", value: "a@example.com", disabled: false, checked: null, bbox: { x: 0, y: 0, width: 100, height: 20 }, tag: "input", type: "email" },
  { ref: "e2", role: "button", name: "提交", value: null, disabled: false, checked: null, bbox: { x: 0, y: 30, width: 80, height: 24 }, tag: "button", type: null }
]) {
  const frame = {
    evaluate: vi.fn(async () => ({
      url: "https://example.com/frame",
      name: "main",
      text,
      elements
    }))
  };
  return {
    frames: vi.fn(() => [frame]),
    url: vi.fn(() => "https://example.com"),
    title: vi.fn(async () => "示例")
  } as never;
}

describe("captureBrowserSnapshot", () => {
  it("renders a compact element list and stable digest", async () => {
    const page = fakePage();
    const first = await captureBrowserSnapshot(page);
    const second = await captureBrowserSnapshot(page);
    expect(first.content).toContain("页面：示例");
    expect(first.content).toContain("- e1");
    expect(first.content).toContain("「邮箱」");
    expect(first.content).not.toContain("password");
    expect(first.digest).toBe(second.digest);
  });

  it("truncates very large pages", async () => {
    const elements = Array.from({ length: 500 }, (_, index) => ({
      ref: `e${index + 1}`,
      role: "button",
      name: `按钮 ${index + 1}`,
      value: null,
      disabled: false,
      checked: null,
      bbox: { x: 0, y: index, width: 80, height: 20 },
      tag: "button",
      type: null
    }));
    const page = fakePage("x".repeat(20_000), elements);
    const snapshot = await captureBrowserSnapshot(page);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.content.length).toBeLessThanOrEqual(16_001);
  });

  it("collects elements from every frame", async () => {
    const frames = [
      {
        evaluate: vi.fn(async () => ({
          url: "https://example.com",
          name: "main",
          text: "主页面",
          elements: [
            { ref: "e1", role: "button", name: "主按钮", value: null, disabled: false, checked: null, bbox: { x: 0, y: 0, width: 80, height: 20 }, tag: "button", type: null }
          ]
        }))
      },
      {
        evaluate: vi.fn(async () => ({
          url: "https://example.com/embedded",
          name: "embedded",
          text: "嵌入页面",
          elements: [
            { ref: "e2", role: "textbox", name: "姓名", value: "Ada", disabled: false, checked: null, bbox: { x: 0, y: 40, width: 160, height: 24 }, tag: "input", type: "text" }
          ]
        }))
      }
    ];
    const page = {
      frames: vi.fn(() => frames),
      url: vi.fn(() => "https://example.com"),
      title: vi.fn(async () => "多 Frame 页面")
    } as never;

    const snapshot = await captureBrowserSnapshot(page);

    expect(snapshot.elements).toHaveLength(2);
    expect(snapshot.elements[0]).toMatchObject({ ref: "e1", frameIndex: 0 });
    expect(snapshot.elements[1]).toMatchObject({ ref: "e2", frameIndex: 1 });
    expect(snapshot.content).toContain("Frame 1：embedded https://example.com/embedded");
  });
});
