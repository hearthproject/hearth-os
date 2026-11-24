import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractFilePaths,
  parseLocalFileRequest,
  searchLocalFile,
  storeOutgoingAttachment
} from "./chat-file-delivery.ts";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hearth-file-delivery-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("local file send requests", () => {
  it("parses the screenshot request and keeps the PPT type hint", () => {
    const request = parseLocalFileRequest("把孙中山的一生这个PPT发给我");
    expect(request).toMatchObject({ query: "孙中山的一生", extensions: [".ppt", ".pptx"] });
  });

  it("parses an explicit file name without a verb prefix", () => {
    expect(parseLocalFileRequest("发我 报价单.xlsx")).toMatchObject({
      query: "报价单",
      extensions: [".xlsx"]
    });
  });

  it("does not hijack a request to author a new file", () => {
    expect(parseLocalFileRequest("把方案写成 Word 发给我")).toBeNull();
  });

  it("finds the PPT in a nested folder and ignores Office lock files", () => {
    const nested = join(root, "资料");
    mkdirSync(nested, { recursive: true });
    const request = parseLocalFileRequest("把孙中山的一生这个PPT发给我")!;
    writeFileSync(join(nested, "~$孙中山的一生.pptx"), "lock");
    writeFileSync(join(nested, "孙中山的一生.pptx"), "slides");
    writeFileSync(join(nested, "其他.pptx"), "other");
    const result = searchLocalFile(request, { roots: [root] });
    expect(result?.path).toBe(join(nested, "孙中山的一生.pptx"));
    expect(result?.candidates[0]).toBe(join(nested, "孙中山的一生.pptx"));
  });

  it("uses a path already mentioned earlier in the conversation", () => {
    const file = join(root, "会议纪要.pdf");
    writeFileSync(file, "minutes");
    const request = parseLocalFileRequest("把会议纪要这个 PDF 发给我")!;
    const result = searchLocalFile(request, { roots: [], hintPaths: [file] });
    expect(result?.path).toBe(file);
  });

  it("copies an outbound file into the attachment store with its display name", () => {
    const file = join(root, "孙中山的一生.pptx");
    writeFileSync(file, "slides");
    const attachment = storeOutgoingAttachment(file, join(root, "attachments"));
    expect(attachment).toMatchObject({
      name: "孙中山的一生.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      bytes: 6
    });
    expect(attachment.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("extracts absolute Windows paths from history including spaces", () => {
    expect(extractFilePaths("PPT 在 `C:\\Users\\Jason\\Desktop\\孙中山的一生.pptx`。")).toEqual([
      "C:\\Users\\Jason\\Desktop\\孙中山的一生.pptx"
    ]);
  });
});
