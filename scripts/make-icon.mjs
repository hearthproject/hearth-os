import sharp from "sharp";
import pngToIco from "png-to-ico";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repoRoot, "docs", "public", "brand", "hearth-os-logo.png");
const buildDir = join(repoRoot, "apps", "desktop", "build");
const resourcesDir = join(repoRoot, "apps", "desktop", "resources");
mkdirSync(buildDir, { recursive: true });
mkdirSync(resourcesDir, { recursive: true });

const square = await sharp(source)
  .extract({ left: 0, top: 0, width: 256, height: 256 })
  .png()
  .toBuffer();

const sizes = [16, 32, 48, 64, 128, 256];
const pngFiles = [];
for (const size of sizes) {
  const path = join(buildDir, `icon-${size}.png`);
  await sharp(square).resize(size, size).png().toFile(path);
  pngFiles.push(path);
}

writeFileSync(join(buildDir, "icon.ico"), await pngToIco(pngFiles));

// The tray image sits on a dark taskbar, so turn the logo's white backdrop
// transparent while keeping the black/orange mark.
const { data, info } = await sharp(square).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
for (let i = 0; i < data.length; i += 4) {
  if (data[i] >= 240 && data[i + 1] >= 240 && data[i + 2] >= 240) {
    data[i + 3] = 0;
  }
}
await sharp(data, { raw: info }).png().toFile(join(resourcesDir, "tray.png"));

console.log(`icon: ${join(buildDir, "icon.ico")}`);
console.log(`tray: ${join(resourcesDir, "tray.png")}`);
