import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unzipSync, zipSync } from "fflate";
import { Jimp } from "jimp";
import { prepareImAttachments, shrinkOfficeArchive } from "./im-media.ts";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hearth-im-media-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function noisyPng(width: number, height: number): Promise<Buffer> {
  const image = new Jimp({ width, height, color: 0xffffffff });
  const data = image.bitmap.data;
  for (let index = 0; index < data.length; index += 4) {
    data[index] = Math.floor(Math.random() * 256);
    data[index + 1] = Math.floor(Math.random() * 256);
    data[index + 2] = Math.floor(Math.random() * 256);
    data[index + 3] = 255;
  }
  return Buffer.from(await image.getBuffer("image/png"));
}

function minimalPptx(png: Buffer): Buffer {
  return Buffer.from(zipSync({
    "[Content_Types].xml": new Uint8Array(Buffer.from(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="png" ContentType="image/png"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + "</Types>"
    )),
    "ppt/slides/_rels/slide1.xml.rels": new Uint8Array(Buffer.from(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>'
      + "</Relationships>"
    )),
    "ppt/slides/slide1.xml": new Uint8Array(Buffer.from(
      '<?xml version="1.0"?><slide xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:blip r:embed="rId1"/></slide>'
    )),
    "ppt/slides/media/image1.png": new Uint8Array(png)
  }));
}

describe("WeChat Office shrinking", () => {
  it("renames images to JPEG, rewrites OOXML relationships, and shrinks the archive", async () => {
    const png = await noisyPng(1200, 900);
    expect(png.byteLength).toBeGreaterThan(1024 * 1024);
    const source = minimalPptx(png);
    const shrunk = await shrinkOfficeArchive(source, "测试.pptx", 25 * 1024 * 1024);
    expect(shrunk.byteLength).toBeLessThan(source.byteLength * 0.6);

    const entries = unzipSync(shrunk);
    expect(entries["ppt/slides/media/image1.png"]).toBeUndefined();
    expect(entries["ppt/slides/media/image1.jpg"]).toBeDefined();
    const rels = Buffer.from(entries["ppt/slides/_rels/slide1.xml.rels"]!).toString("utf8");
    expect(rels).toContain("image1.jpg");
    expect(rels).not.toContain("image1.png");
    const types = Buffer.from(entries["[Content_Types].xml"]!).toString("utf8");
    expect(types).toContain('Extension="jpg"');
  });

  it("creates a new '微信版' attachment when the original exceeds the limit", async () => {
    const png = await noisyPng(1200, 900);
    const id = "11111111-2222-3333-4444-555555555555";
    const file = join(root, `${id}.pptx`);
    writeFileSync(file, minimalPptx(png));
    const before = statSync(file).size;
    const prepared = await prepareImAttachments([
      {
        id,
        name: "孙中山的一生.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        bytes: before
      }
    ], root, { maxBytes: 2 * 1024 * 1024 });
    expect(prepared.failures).toEqual([]);
    expect(prepared.items).toHaveLength(1);
    expect(prepared.items[0]).toMatchObject({
      originalName: "孙中山的一生.pptx",
      compressed: true
    });
    expect(prepared.items[0]!.attachment.name).toContain("微信版");
    expect(prepared.items[0]!.attachment.bytes).toBeLessThan(before);
  });
});
