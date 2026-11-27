import { exec } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { chromium } from "playwright-core";
import { ALLOWED_5XX, ARTIFACTS_DIR, LAUNCH_OPTIONS, RATE_LIMIT_RESET_CMD, VIEWPORTS, WEB_URL } from "./config.mjs";

let browserPromise;

/** One Edge process per test file. Each test gets its own context, so cookies and storage never leak. */
export function browser() {
  browserPromise ??= chromium.launch(LAUNCH_OPTIONS);
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const instance = await browserPromise;
  browserPromise = undefined;
  await instance.close();
}

/** Clears the API's rate-limit counters, when RATE_LIMIT_RESET_CMD is set. A no-op otherwise. */
export function resetRateLimits() {
  if (!RATE_LIMIT_RESET_CMD) return Promise.resolve();
  return new Promise((resolve, reject) => {
    exec(RATE_LIMIT_RESET_CMD, { timeout: 30_000 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`RATE_LIMIT_RESET_CMD failed: ${error.message}\n${stderr}`));
      else resolve();
    });
  });
}

/** Sets the theme before any page script runs, the same way a returning visitor's preference would be read. */
function themeScript(theme) {
  return `(() => { try { localStorage.setItem("theme", ${JSON.stringify(theme)}); } catch (e) {} })();`;
}

/**
 * Records what a page does wrong: console errors, uncaught exceptions and responses >= 500.
 * Expected 503s from unconfigured features are allowed only when their body says NOT_CONFIGURED.
 *
 * `expectStatus` lists the failed responses a scenario is testing on purpose, as { path, status }, such as a
 * normal user's 404 on an admin page. The browser logs each one as "Failed to load resource", and that line is
 * accepted only for the exact URL and status declared. Any other console error, or any other 4xx/5xx, still fails.
 */
export function watch(page, { expectStatus = [] } = {}) {
  const problems = [];
  const pending = [];
  const allowedUrls = [];

  const allowedFor = (status, url) => ALLOWED_5XX.find((rule) => rule.status === status && rule.url.test(url));
  const expected = expectStatus.map((rule) => ({ url: new URL(rule.path, WEB_URL).href, status: String(rule.status) }));
  const isExpectedFailure = (text, url) => {
    const status = text.match(/status of (\d{3})/)?.[1];
    return !!status && expected.some((rule) => rule.url === url && rule.status === status);
  };

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const url = message.location()?.url ?? "";
    // The browser logs each failed resource too; those are judged by the response check below.
    if (/status of 503/.test(message.text()) && allowedFor(503, url)) return;
    // A rejected API request (wrong password, signed-out calls) is logged by the browser as a failed resource.
    // That is the app answering correctly, so it is not an error. Failing assets and 5xx responses still count.
    if (/status of 4\d\d/.test(message.text()) && /\/api\/v1\//.test(url)) return;
    // A declared failure: the exact URL answered the exact status the scenario expects.
    if (/Failed to load resource/.test(message.text()) && isExpectedFailure(message.text(), url)) return;
    problems.push({ kind: "console", text: message.text(), url });
  });
  page.on("pageerror", (error) => problems.push({ kind: "pageerror", text: error.message }));
  page.on("response", (response) => {
    if (response.status() < 500) return;
    const url = response.url();
    const rule = allowedFor(response.status(), url);
    pending.push(
      (async () => {
        if (rule) {
          const body = await response.text().catch(() => "");
          if (body.includes(`"${rule.code}"`)) {
            allowedUrls.push(url);
            return;
          }
        }
        problems.push({ kind: "http", text: `${response.status()} ${response.request().method()} ${url}` });
      })(),
    );
  });

  return {
    allowedUrls,
    /** Waits for in-flight response bodies, then throws if anything unexpected was recorded. */
    async check(label = "page") {
      await Promise.allSettled(pending.splice(0));
      if (problems.length === 0) return;
      const lines = problems.map((problem) => `  - [${problem.kind}] ${problem.text}${problem.url ? ` (${problem.url})` : ""}`);
      throw new Error(`${label}: ${problems.length} browser problem(s):\n${lines.join("\n")}`);
    },
    problems,
  };
}

/**
 * Fails when the page is wider than the viewport, the usual sign of a layout that spills off a phone screen.
 * Reports the element that reaches furthest right so the failure points at the cause.
 */
export async function assertNoOverflow(page, label = "page") {
  const report = await page.evaluate(() => {
    const root = document.documentElement;
    if (root.scrollWidth <= root.clientWidth) return null;
    let widest = null;
    for (const element of document.body.querySelectorAll("*")) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (!widest || rect.right > widest.right) {
        widest = {
          tag: element.tagName.toLowerCase(),
          id: element.id || undefined,
          right: Math.round(rect.right),
          text: (element.textContent || "").trim().slice(0, 60),
        };
      }
    }
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, widest };
  });
  if (!report) return;
  const widest = report.widest ? ` widest element: <${report.widest.tag}${report.widest.id ? `#${report.widest.id}` : ""}> right edge ${report.widest.right}px, text "${report.widest.text}"` : "";
  throw new Error(`${label}: horizontal overflow, scrollWidth ${report.scrollWidth} > clientWidth ${report.clientWidth}.${widest}`);
}

/**
 * Opens a page in a fresh context with the theme, viewport and motion preference applied.
 * `expectStatus` is passed to the guard; see watch().
 */
export async function openPage({ theme = "light", viewport = "desktop", reducedMotion = false, storageState, expectStatus } = {}) {
  const instance = await browser();
  const context = await instance.newContext({
    baseURL: WEB_URL,
    viewport: VIEWPORTS[viewport] ?? VIEWPORTS.desktop,
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
    storageState,
  });
  await context.addInitScript(themeScript(theme));
  const page = await context.newPage();
  // The dev server compiles each route on first visit and the machine is often busy, so these are generous.
  page.setDefaultTimeout(45_000);
  page.setDefaultNavigationTimeout(90_000);
  const guard = watch(page, { expectStatus });
  return {
    context,
    page,
    guard,
    theme,
    viewport,
    async close() {
      await context.close().catch(() => {});
    },
  };
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
}

/** Saves a full-page screenshot and the page URL for a failed test, into the gitignored artifacts folder. */
export async function captureFailure(page, name) {
  if (!page || page.isClosed()) return undefined;
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  const base = join(ARTIFACTS_DIR, `${slug(name)}-${Date.now()}`);
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  await writeFile(`${base}.txt`, `${page.url()}\n`).catch(() => {});
  return `${base}.png`;
}

/**
 * Registers one browser test. It clears rate-limit counters first (when configured), opens a fresh context,
 * runs `body`, then fails on any browser problem recorded during the test. A failure keeps a screenshot.
 */
export function scenario(name, options, body, { skip } = {}) {
  test(name, { skip }, async () => {
    await resetRateLimits();
    const opened = await openPage(options);
    try {
      await body(opened);
      await opened.guard.check(name);
    } catch (error) {
      const shot = await captureFailure(opened.page, name);
      if (shot && error instanceof Error) error.message += `\n  screenshot: ${shot}`;
      throw error;
    } finally {
      await opened.close();
    }
  });
}

/** A label for a matrix case, such as "light · phone". */
export function caseName(base, { theme, viewport, reducedMotion } = {}) {
  const parts = [theme, viewport, reducedMotion ? "reduced-motion" : undefined].filter(Boolean);
  return parts.length ? `${base} [${parts.join(" · ")}]` : base;
}

/**
 * Navigates and waits until the page is usable: the ready element is visible and React has attached to it.
 * Clicking before hydration does nothing (the native form submit has no handler), so this matters on a slow
 * dev server. It waits on a condition, not on a fixed delay.
 */
export async function visit(page, path, { ready = "h1" } = {}) {
  const response = await page.goto(new URL(path, WEB_URL).href, { waitUntil: "domcontentloaded" });
  await page.locator(ready).first().waitFor({ state: "visible" });
  await waitForHydration(page, ready);
  return response;
}

/**
 * Waits until the page has finished loading its data: no skeletons, busy regions or "Loading..." status lines.
 * Pages that stream live updates never go network-idle, so this checks the UI instead.
 */
export async function waitForSettled(page) {
  await page.waitForFunction(() => {
    if (document.querySelector('[aria-busy="true"], [aria-label^="Loading"]')) return false;
    // Leaf elements only, so a large container is never mistaken for a loading line.
    return ![...document.body.querySelectorAll("*")].some(
      (node) => node.childElementCount === 0 && /^Loading/.test(node.textContent.trim()) && node.getBoundingClientRect().width > 0,
    );
  });
}

/** Waits until React has attached to the first element matching `selector`. */
export function waitForHydration(page, selector) {
  return page.waitForFunction(
    (target) => {
      const node = document.querySelector(target);
      return !!node && Object.keys(node).some((key) => key.startsWith("__reactFiber") || key.startsWith("__reactProps"));
    },
    selector,
  );
}

/** Closes this file's browser once its tests finish. */
after(() => closeBrowser());
