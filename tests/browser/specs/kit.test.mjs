// The design kit: /kit and every /kit/effects/* page load with no errors, in both themes.
import { THEMES, WEB_URL } from "../lib/config.mjs";
import { assertNoOverflow, caseName, scenario, visit, waitForSettled } from "../lib/session.mjs";

/**
 * Reads the effect links from the kit index, so a new effect is covered without editing this file.
 * Runs before the tests are registered; if the app is down, the file fails here with a clear message.
 */
async function discoverEffects() {
  const response = await fetch(`${WEB_URL}/kit`);
  if (!response.ok) throw new Error(`GET ${WEB_URL}/kit returned ${response.status}; is the web app running?`);
  const html = await response.text();
  const found = new Set([...html.matchAll(/href="(\/kit\/effects\/[a-z0-9-]+)"/g)].map((match) => match[1]));
  if (found.size === 0) throw new Error("No /kit/effects links were found on /kit");
  return [...found].sort();
}

const effects = await discoverEffects();

for (const theme of THEMES) {
  scenario(caseName("kit: /kit index loads", { theme }), { theme }, async ({ page }) => {
    await visit(page, "/kit", { ready: "h1" });
    await waitForSettled(page);
    await assertNoOverflow(page, "/kit");
  });
}

for (const theme of THEMES) {
  for (const path of effects) {
    scenario(caseName(`kit: ${path} loads`, { theme }), { theme }, async ({ page }) => {
      // Some effects have no heading, so the first visible paragraph or heading marks "rendered and hydrated".
      // Effects also show "Loading" on purpose as a demo state, so this does not wait for loading to finish.
      const response = await visit(page, path, { ready: "h1, h2, p" });
      if (response.status() !== 200) throw new Error(`HTTP ${response.status()} for ${path}`);
    });
  }
}

scenario(caseName("kit: the phone layout of /kit has no overflow", { theme: "dark", viewport: "phone" }), { theme: "dark", viewport: "phone" }, async ({ page }) => {
  await visit(page, "/kit", { ready: "h1" });
  await waitForSettled(page);
  await assertNoOverflow(page, "/kit on a phone");
});
