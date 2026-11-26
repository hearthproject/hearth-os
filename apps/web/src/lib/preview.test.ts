import { describe, expect, it } from "vitest";
import { fileExtension, previewKind } from "./preview.ts";

describe("previewKind", () => {
  it("classifies markdown, images, pdf and plain text", () => {
    expect(previewKind("notes.md", "text/markdown")).toBe("markdown");
    expect(previewKind("report.pdf", "application/pdf")).toBe("pdf");
    expect(previewKind("chart.png", "image/png")).toBe("image");
    expect(previewKind("data.csv", "text/csv")).toBe("sheet");
    expect(previewKind("main.ts", "text/plain")).toBe("text");
    expect(previewKind("package.json", "application/json")).toBe("text");
  });

  it("previews Office documents and media inline", () => {
    expect(previewKind("deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe("slides");
    expect(previewKind("book.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("sheet");
    expect(previewKind("memo.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("doc");
    expect(previewKind("clip.mp4", "video/mp4")).toBe("video");
    expect(previewKind("voice.m4a", "audio/mp4")).toBe("audio");
  });

  it("falls back to download for unsupported binaries", () => {
    expect(previewKind("archive.zip", "application/zip")).toBe("binary");
    expect(previewKind("legacy.ppt", "application/vnd.ms-powerpoint")).toBe("binary");
  });

  it("does not treat svg as a rendered image", () => {
    expect(previewKind("logo.svg", "image/svg+xml")).toBe("text");
  });
});

describe("fileExtension", () => {
  it("returns an upper-case label with a safe fallback", () => {
    expect(fileExtension("a/b/report.pdf")).toBe("PDF");
    expect(fileExtension("README")).toBe("FILE");
  });
});
