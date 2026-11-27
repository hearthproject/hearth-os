import { describe, expect, it } from "vitest";
import {
  appendPlanBlock,
  createPlanBlock,
  nextItemMarker,
  parsePlanBlocks,
  serializePlanBlocks
} from "./plan-editor.ts";

const SAMPLE = [
  "# 实施计划",
  "",
  "## 调查结论",
  "当前只有一条路径。",
  "",
  "## 执行步骤",
  "1. 修改组件：增加按钮",
  "2. 补充样式",
  "",
  "## 验证方法",
  "- 运行 `npm test`",
  "- 检查页面",
  "",
  "## 风险与非目标",
  "不改后端协议。",
  "",
  "```bash",
  "# 注意：这里的 - 不应该被当成列表项",
  "npm test -w @hearth/web",
  "```"
].join("\n");

describe("plan editor blocks", () => {
  it("round-trips an untouched plan verbatim", () => {
    expect(serializePlanBlocks(parsePlanBlocks(SAMPLE))).toBe(SAMPLE);
  });

  it("does not treat dashes inside fenced code as list items", () => {
    const blocks = parsePlanBlocks(SAMPLE);
    const code = blocks.filter((block) => block.kind === "code");
    expect(code).toHaveLength(1);
    expect(code[0]!.content).toContain("npm test -w @hearth/web");
    expect(blocks.filter((block) => block.kind === "item")).toHaveLength(4);
  });

  it("groups consecutive prose lines into one block", () => {
    const blocks = parsePlanBlocks("## 结论\n第一行\n第二行\n");
    expect(blocks.filter((block) => block.kind === "text")).toHaveLength(1);
    expect(blocks.find((block) => block.kind === "text")!.content).toBe("第一行\n第二行");
  });

  it("supports removing an item and appending a new one", () => {
    const blocks = parsePlanBlocks("## 步骤\n1. 第一步\n2. 第二步\n");
    const kept = blocks.filter((block) => block.content !== "第二步");
    const added = createPlanBlock("item", "第三步");
    added.marker = nextItemMarker(kept, kept.find((block) => block.kind === "item")!.id);
    expect(added.marker).toBe("2. ");
    expect(serializePlanBlocks(appendPlanBlock(kept, added))).toBe("## 步骤\n1. 第一步\n2. 第三步\n");
  });

  it("keeps numbered markers consistent when inserting after an item", () => {
    const blocks = parsePlanBlocks("## 步骤\n1. 第一步\n2. 第二步\n");
    const first = blocks.find((block) => block.kind === "item")!;
    const inserted = createPlanBlock("item", "插入的步骤");
    inserted.marker = nextItemMarker(blocks, first.id);
    const index = blocks.indexOf(first);
    const next = [...blocks];
    next.splice(index + 1, 0, inserted);
    expect(serializePlanBlocks(next)).toBe("## 步骤\n1. 第一步\n2. 插入的步骤\n2. 第二步\n");
  });

  it("can delete a whole heading with its section content", () => {
    const blocks = parsePlanBlocks("## 一\n内容一\n\n## 二\n内容二\n");
    const firstHeading = blocks.find((block) => block.kind === "heading")!;
    const start = blocks.indexOf(firstHeading);
    const nextHeading = blocks.findIndex((block, index) => index > start && block.kind === "heading");
    const kept = blocks.filter((_, index) => index < start || index >= nextHeading);
    expect(serializePlanBlocks(kept)).toBe("## 二\n内容二\n");
  });
});
