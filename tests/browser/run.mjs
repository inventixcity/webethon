#!/usr/bin/env node
// Runs the browser suite file by file and prints a pass/fail table.
//
//   node run.mjs                 run everything
//   node run.mjs auth kit        run only spec files whose name contains "auth" or "kit"
//   node run.mjs --name "dark"   run only tests whose title contains "dark"
//
// Each spec file runs in its own process (its own Edge instance), one after another. Results are also written to
// artifacts/results.json. The exit code is 1 when anything fails, so this works in CI.
import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(here, "artifacts");
const COLUMN_LIMIT = { test: 92, reason: 150 };

const args = process.argv.slice(2);
let nameFilter;
const fileFilters = [];
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--name") nameFilter = args[++index];
  else fileFilters.push(args[index]);
}

const files = [
  ...(await readdir(join(here, "specs"))).filter((name) => name.endsWith(".test.mjs")).map((name) => join("specs", name)),
  ...(await readdir(join(here, "unit"))).filter((name) => name.endsWith(".test.mjs")).map((name) => join("unit", name)),
].sort((a, b) => (a.startsWith("unit") ? 1 : 0) - (b.startsWith("unit") ? 1 : 0) || a.localeCompare(b));

const selected = files.filter((file) => fileFilters.length === 0 || fileFilters.some((filter) => file.includes(filter)));

/** Runs one spec file with the TAP reporter and returns its raw output. */
function runFile(file) {
  const argv = ["--test", "--test-reporter=tap"];
  if (nameFilter) argv.push(`--test-name-pattern=${nameFilter}`);
  argv.push(file);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: here, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Turns TAP into rows. Top-level results are the only ones here (each scenario is one test), so a line that
 * starts with "ok" or "not ok" at column 0 is a result, and the indented YAML block after it holds the error.
 */
export function parseTap(output) {
  const lines = output.split(/\r?\n/);
  const rows = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b ?(.*))?$/);
    if (!match) continue;
    const row = { name: match[2].trim(), status: match[1] === "ok" ? "PASS" : "FAIL", reason: "", ms: 0 };
    if (match[3] === "SKIP") {
      row.status = "SKIP";
      row.reason = (match[4] || "").trim();
    }
    // The YAML block runs until a line equal to "  ...".
    let cursor = index + 1;
    const block = [];
    while (cursor < lines.length && lines[cursor] !== "  ...") {
      block.push(lines[cursor]);
      cursor++;
    }
    const duration = block.find((line) => line.startsWith("  duration_ms:"));
    if (duration) row.ms = Math.round(Number(duration.split(":")[1]));
    if (row.status === "FAIL") {
      const start = block.findIndex((line) => line.startsWith("  error:"));
      if (start >= 0) {
        const first = block[start].replace(/^ {2}error: \|?-?\s*'?/, "").replace(/'$/, "");
        const more = [];
        for (let k = start + 1; k < block.length && /^ {4}/.test(block[k]); k++) more.push(block[k].slice(4));
        row.reason = [first, ...more].filter(Boolean).join(" | ");
      } else {
        row.reason = "failed (no error text was reported)";
      }
    }
    rows.push(row);
    index = cursor;
  }
  return rows;
}

function clip(text, width) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

function pad(text, width) {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

const results = [];
const fileWidth = Math.min(28, Math.max(4, ...selected.map((file) => file.length)));
const nameWidth = COLUMN_LIMIT.test;
console.log(`${pad("RESULT", 6)}  ${pad("FILE", fileWidth)}  ${pad("TEST", nameWidth)}  REASON`);
console.log(`${"-".repeat(6)}  ${"-".repeat(fileWidth)}  ${"-".repeat(nameWidth)}  ${"-".repeat(20)}`);

// Each file's rows print as soon as that file finishes, so failures show while the rest of the suite runs.
for (const file of selected) {
  const started = Date.now();
  const { code, stdout, stderr } = await runFile(file);
  // Node adds a file-level "ok <path>" line when a name filter matches nothing. It is not a test, so drop it.
  const rows = parseTap(stdout).filter((row) => !/\.mjs$/.test(row.name));
  if (rows.length === 0 && code !== 0) {
    const detail = (stderr || stdout).split(/\r?\n/).filter(Boolean).slice(0, 4).join(" | ") || `exit code ${code}`;
    rows.push({ name: "(file did not run any tests)", status: "FAIL", reason: clip(detail, 400), ms: Date.now() - started });
  }
  const shortFile = file.replaceAll("\\", "/");
  for (const row of rows) {
    const entry = { file: shortFile, ...row };
    results.push(entry);
    const reason = row.status === "PASS" ? "" : clip(row.reason, COLUMN_LIMIT.reason);
    console.log(`${pad(row.status, 6)}  ${pad(clip(shortFile, fileWidth), fileWidth)}  ${pad(clip(row.name, nameWidth), nameWidth)}  ${reason}`);
  }
}

const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
for (const row of results) counts[row.status]++;
console.log("");
console.log(`${counts.PASS} passed, ${counts.FAIL} failed, ${counts.SKIP} skipped (${results.length} tests)`);

const failures = results.filter((row) => row.status === "FAIL");
if (failures.length) {
  console.log("\nFailures:");
  for (const row of failures) console.log(`- [${row.file}] ${row.name}\n    ${row.reason.replace(/ \| /g, "\n    ")}`);
}

await mkdir(ARTIFACTS, { recursive: true });
await writeFile(join(ARTIFACTS, "results.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), counts, results }, null, 2)}\n`);
process.exitCode = counts.FAIL > 0 ? 1 : 0;
