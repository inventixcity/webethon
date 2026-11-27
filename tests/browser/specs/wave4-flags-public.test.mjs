// Public feature flags: the app reads GET /flags once per load, and a flag that is on changes a visible element only
// where a component reads it with useFlag. The second check is skipped until a component reads a flag.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { THEMES } from "../lib/config.mjs";
import { caseName, scenario, visit, waitForSettled } from "../lib/session.mjs";

const here = dirname(fileURLToPath(import.meta.url));
/** The web app's source, next to this repo: tests/browser/specs -> repo root -> "ui components/src". */
const UI_SRC = join(here, "..", "..", "..", "ui components", "src");
const FLAGS_LIB = "lib/flags/";

/** Source files under the app that call useFlag(...), outside lib/flags where it is defined. */
function findUseFlagCallers(dir = UI_SRC, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      findUseFlagCallers(full, found);
      continue;
    }
    if (!/\.(tsx?|jsx?)$/.test(entry)) continue;
    const path = relative(UI_SRC, full).split(sep).join("/");
    if (path.startsWith(FLAGS_LIB)) continue;
    if (/\buseFlag\(/.test(readFileSync(full, "utf8"))) found.push(path);
  }
  return found;
}

/** Why the visible-element check is skipped, computed from the source so it updates itself when a consumer lands. */
function visibleFlagSkipReason() {
  if (!existsSync(UI_SRC)) return "ui components/src was not found next to this repo, so the flag consumers cannot be checked";
  const callers = findUseFlagCallers();
  if (callers.length === 0) {
    return "no component calls useFlag yet (lib/flags only defines it), so no visible element changes with a flag";
  }
  return `components now call useFlag (${callers.join(", ")}), but this spec has no flag key or element to check yet`;
}

const FLAG_READ = (url) => new URL(url).pathname === "/api/v1/flags";

for (const theme of THEMES) {
  scenario(caseName("flags: the app reads GET /flags once, and not again on in-app navigation", { theme }), { theme }, async ({ page }) => {
    const reads = [];
    page.on("request", (request) => {
      if (request.method() === "GET" && FLAG_READ(request.url())) reads.push(request.url());
    });

    // Anonymous visitors are allowed to read flags, so no sign-in is needed here.
    const firstRead = page.waitForRequest((request) => request.method() === "GET" && FLAG_READ(request.url()));
    await visit(page, "/kit", { ready: "h1" });
    await firstRead;
    await waitForSettled(page);
    assert.ok(reads.length <= 2, `GET /flags should run at most twice on load (dev Strict Mode runs effects twice), ran ${reads.length} times`);

    // Moving between pages inside the app keeps the same provider, so no second read.
    const link = page.locator('a[href^="/kit/effects/"]').first();
    await link.waitFor({ state: "visible" });
    const href = await link.getAttribute("href");
    await link.click();
    await page.waitForURL((url) => url.pathname === href);
    await waitForSettled(page);
    assert.ok(reads.length <= 2, `GET /flags should not run again on in-app navigation, ran ${reads.length} times`);
  });
}

const visibleFlagSkip = visibleFlagSkipReason();

for (const theme of THEMES) {
  scenario(
    caseName("flags: a flag that is on for everyone changes a visible element where a component uses useFlag", { theme }),
    { theme },
    async () => {
      // Not written yet: there is no component reading a flag, so there is no element to check. Add the flag key and
      // the element here once one exists. Do not add a debug UI to the app to make this possible.
      throw new Error("not written: see the skip reason");
    },
    { skip: visibleFlagSkip },
  );
}
