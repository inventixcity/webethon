// Helpers shared by the wave 4 specs. They read only what the UI shows or what the browser downloads.
import { readFile } from "node:fs/promises";
import { signInViaUi, waitForPath } from "./accounts.mjs";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./config.mjs";

/** Why the admin specs are skipped, or undefined when an admin account is configured. */
export const ADMIN_SKIP_REASON =
  ADMIN_EMAIL && ADMIN_PASSWORD
    ? undefined
    : "set ADMIN_EMAIL and ADMIN_PASSWORD (an account listed in the API's ADMIN_EMAILS) to run the admin specs";

/** Signs the configured admin in through the form. Resolves once the browser has left the login page. */
export async function signInAsAdmin(page) {
  await signInViaUi(page, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  await waitForPath(page, /^\/app(\/|$)/);
}

/**
 * Hides the development-only kit bar ("All screens" / theme). In dev it is fixed to the bottom of every page and can
 * cover a control a test clicks, such as the New flag drawer's Save button. Production has no kit bar. Call this after
 * each navigation, because a page load drops the style tag.
 */
export function hideDevKitNav(page) {
  return page.addStyleTag({ content: "[data-kit-nav] { display: none !important; }" });
}

/**
 * Names of looping animations that are still running on the page. Only Web Animations are visible here, which is
 * what CSS animations and transitions create. Paused ones are not running, so they are not reported.
 */
export function runningInfiniteAnimations(page) {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => animation.playState !== "paused" && animation.effect?.getComputedTiming().iterations === Infinity)
      .map((animation) => ("animationName" in animation && animation.animationName) || animation.id || "unnamed animation"),
  );
}

/** Fails, naming each animation, when a looping animation is still running. Used for the reduced-motion sweep. */
export async function assertNoInfiniteAnimation(page, label) {
  const running = await runningInfiniteAnimations(page);
  if (running.length === 0) return;
  throw new Error(`${label}: ${running.length} looping animation(s) still running under reduced motion: ${running.join(", ")}`);
}

/** Reads a finished download, from Playwright's download event, as text. */
export async function readDownload(download) {
  const name = download.suggestedFilename();
  const path = await download.path();
  if (!path) throw new Error(`download ${name} did not finish: ${await download.failure()}`);
  return { name, text: await readFile(path, "utf8") };
}

/** The column names on the first line of a CSV, without a leading byte-order mark or surrounding quotes. */
export function csvHeader(text) {
  const firstLine = text.replace(/^﻿/, "").split(/\r?\n/)[0] ?? "";
  return firstLine.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
}

/** A file for setInputFiles, built in memory so no fixture is written into the repo. */
export function inMemoryFile(name, mimeType, contents) {
  return { name, mimeType, buffer: Buffer.isBuffer(contents) ? contents : Buffer.from(contents) };
}
