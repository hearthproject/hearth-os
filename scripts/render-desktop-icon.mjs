import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const repo = "D:/App/hearth-os";
const outDir = join(repo, "assets/brand/desktop");
mkdirSync(outDir, { recursive: true });

const variants = [
  { name: "hearth-desktop-icon", svg: "assets/brand/hearth-desktop-icon.svg" },
  { name: "hearth-desktop-icon-light", svg: "assets/brand/hearth-desktop-icon-light.svg" }
];
const sizes = [1024, 512, 256, 128, 64, 48, 32, 16];

for (const variant of variants) {
  const svg = readFileSync(join(repo, variant.svg), "utf8");
  for (const size of sizes) {
    await sharp(Buffer.from(svg), { density: Math.max(96, (size / 1024) * 384) })
      .resize(size, size, { fit: "contain" })
      .png({ compressionLevel: 9 })
      .toFile(join(outDir, `${variant.name}-${size}.png`));
  }
  const ico = await pngToIco([256, 128, 64, 48, 32, 16].map((s) => join(outDir, `${variant.name}-${s}.png`)));
  writeFileSync(join(outDir, `${variant.name}.ico`), ico);
  console.log(`${variant.name}: ${sizes.length} png + ico (${ico.length} bytes)`);
}
