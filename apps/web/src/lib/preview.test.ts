import { describe, expect, it } from "vitest";
import { fileExtension, previewKind } from "./preview.ts";

describe("previewKind", () => {
  it("classifies markdown, images, pdf and plain text", () => {
    expect(previewKind("notes.md", "text/markdown")).toBe("markdown");
    expect(previewKind("report.pdf", "application/pdf")).toBe("pdf");
    expect(previewKind("chart.png", "image/png")).toBe("image");
    expect(previewKind("data.csv", "text/csv")).toBe("text");
    expect(previewKind("main.ts", "text/plain")).toBe("text");
    expect(previewKind("package.json", "application/json")).toBe("text");
  });

  it("falls back to download for unsupported binaries", () => {
    expect(previewKind("archive.zip", "application/zip")).toBe("binary");
    expect(previewKind("deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe("binary");
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
