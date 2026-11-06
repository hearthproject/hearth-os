import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractSourceBytes, UnsupportedSourceFormatError } from "./extractors.ts";

describe("source extractors", () => {
  it("converts CSV rows into a traceable Markdown table", async () => {
    const result = await extractSourceBytes(
      Buffer.from('订单,金额,备注\nA-1,42,"含,逗号"\nA-2,18,"多行\n备注"\n'),
      "orders.csv"
    );
    expect(result.title).toBe("orders");
    expect(result.markdown).toContain("| 源文件行 | 订单 | 金额 | 备注 |");
    expect(result.markdown).toContain("| 2 | A-1 | 42 | 含,逗号 |");
    expect(result.markdown).toContain("多行 备注");
    expect(result.coverage.paragraphs).toBe(3);
  });

  it("reads spreadsheet sheets while preserving source row numbers", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("销售");
    sheet.addRow(["订单", "金额"]);
    sheet.addRow(["A-1", 42]);
    sheet.addRow(["A-2", 18]);
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer() as ArrayBuffer);
    const result = await extractSourceBytes(bytes, "sales.xlsx");

    expect(result.coverage.sheets).toEqual(["销售"]);
    expect(result.markdown).toContain("## 工作表：销售");
    expect(result.markdown).toContain("| 2 | A-1 | 42 |");
    expect(result.title).toBe("销售");
  });

  it("converts Word documents to readable Markdown", async () => {
    const bytes = await makeDocx("季度报告", "这是第一段正文。", "这是第二段正文。");
    const result = await extractSourceBytes(bytes, "report.docx");
    expect(result.title).toBe("季度报告");
    expect(result.markdown).toContain("季度报告");
    expect(result.markdown).toContain("这是第一段正文。");
    expect(result.coverage.paragraphs).toBeGreaterThanOrEqual(2);
  });

  it("extracts PDF text with page locations", async () => {
    const result = await extractSourceBytes(makePdf("Hello PDF"), "brief.pdf");
    expect(result.markdown).toContain("## 第 1 页");
    expect(result.markdown).toContain("Hello PDF");
    expect(result.coverage.pages).toBe(1);
  });

  it("rejects legacy formats instead of claiming they were read", async () => {
    await expect(extractSourceBytes(Buffer.from("legacy"), "legacy.doc")).rejects.toBeInstanceOf(UnsupportedSourceFormatError);
  });
});

async function makeDocx(title: string, ...paragraphs: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${escapeXml(title)}</w:t></w:r></w:p>
  ${paragraphs.map((paragraph) => `<w:p><w:r><w:t>${escapeXml(paragraph)}</w:t></w:r></w:p>`).join("\n")}
  <w:sectPr/>
</w:body></w:document>`);
  return new Uint8Array(await zip.generateAsync({ type: "nodebuffer" }));
}

function makePdf(text: string): Uint8Array {
  const escaped = text.replace(/[\\()]/g, (character) => `\\${character}`);
  const stream = `BT /F1 18 Tf 20 100 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "ascii"));
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
