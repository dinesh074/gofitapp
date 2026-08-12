// Rasterizes the brand SVGs into the PNG assets Expo needs.
//   node scripts/make-icons.mjs
import sharp from "sharp";
import { fileURLToPath } from "url";
import path from "path";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "assets");
const icon = path.join(assets, "icon.svg");
const mark = path.join(assets, "mark-white.svg");

async function render(src, out, size, background) {
  const img = sharp(src, { density: 384 }).resize(size, size, {
    fit: "contain",
    background: background || { r: 0, g: 0, b: 0, alpha: 0 },
  });
  await img.png().toFile(path.join(assets, out));
  console.log("wrote", out, size + "x" + size);
}

await render(icon, "icon.png", 1024);
await render(mark, "adaptive-icon.png", 1024); // android foreground (transparent)
await render(mark, "splash-icon.png", 512); // white mark on splash bg color
await render(icon, "favicon.png", 196);
console.log("done");
