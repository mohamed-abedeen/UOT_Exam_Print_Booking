// Makes the PWA icons from the logo (owner 2026-11-27). Run: node scripts/make-icons.mjs [path/to/logo.png]
// Writes public/icons/icon-192.png, icon-512.png, maskable-512.png and app/apple-icon.png.
import sharp from "sharp";
import { mkdirSync } from "node:fs";

const src = process.argv[2] ?? "assets/logo.png";
const white = { r: 255, g: 255, b: 255, alpha: 1 };
mkdirSync("public/icons", { recursive: true });

const plain = (size, out) => sharp(src).resize(size, size, { fit: "contain", background: white }).flatten({ background: white }).png().toFile(out);

// maskable: the launcher may crop to a circle of 80% width, so the logo sits at 80% on a white square
async function padded(size, scale, out) {
  const inner = Math.round(size * scale);
  const logo = await sharp(src).resize(inner, inner, { fit: "contain", background: white }).flatten({ background: white }).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: white } })
    .composite([{ input: logo, gravity: "center" }])
    .png()
    .toFile(out);
}

await plain(192, "public/icons/icon-192.png");
await plain(512, "public/icons/icon-512.png");
await padded(512, 0.8, "public/icons/maskable-512.png");
await padded(180, 0.9, "app/apple-icon.png");
console.log("Icons written from", src);
