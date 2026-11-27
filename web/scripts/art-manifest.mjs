// Writes src/generated/art-manifest.json: a map from image name to its public URL in public/images.
// Preference order per name: .webp, then .png, then .jpg. Runs before dev and build.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imageDir = path.join(root, "public", "images");
const outFile = path.join(root, "src", "generated", "art-manifest.json");
const EXTENSIONS = [".webp", ".png", ".jpg"];

const manifest = {};
if (existsSync(imageDir)) {
  const files = new Set(readdirSync(imageDir));
  const names = new Set();
  for (const file of files) {
    const ext = EXTENSIONS.find((candidate) => file.endsWith(candidate));
    if (ext) names.add(file.slice(0, -ext.length));
  }
  for (const name of [...names].sort()) {
    const ext = EXTENSIONS.find((candidate) => files.has(name + candidate));
    if (ext) manifest[name] = `/images/${name}${ext}`;
  }
}

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`art-manifest: ${Object.keys(manifest).length} image(s)`);
