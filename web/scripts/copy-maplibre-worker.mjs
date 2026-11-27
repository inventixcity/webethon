// MapLibre 6 loads its web worker from a file next to its own module, which the bundler moves.
// Serving the worker from /public and calling setWorkerUrl() keeps maps working (and inside the
// CSP's worker-src 'self'). Runs automatically before dev and build.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const pkgPath = require.resolve("maplibre-gl/package.json");
const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
const source = path.join(path.dirname(pkgPath), "dist", "maplibre-gl-worker.mjs");
const targetDir = path.join(process.cwd(), "public", "vendor");
mkdirSync(targetDir, { recursive: true });
copyFileSync(source, path.join(targetDir, `maplibre-gl-worker-${version}.mjs`));
console.log(`maplibre worker ${version} copied to public/vendor`);
