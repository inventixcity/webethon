// Every signed-in page loads with a 200, no console or page errors, no unexpected 5xx, and no horizontal overflow.
import { completeOnboardingViaUi, signUpViaUi } from "../lib/accounts.mjs";
import { THEMES } from "../lib/config.mjs";
import { assertNoOverflow, caseName, scenario, visit, waitForSettled } from "../lib/session.mjs";

/** Every page a signed-in user can open. The onboarding page is included: it must still load once finished. */
export const APP_PAGES = [
  "/app",
  "/app/dashboard",
  "/app/data",
  "/app/data/notes",
  "/app/data/tasks",
  "/app/ai",
  "/app/activity",
  "/app/files",
  "/app/teams",
  "/app/booking",
  "/app/places",
  "/app/billing",
  "/app/onboarding",
  "/app/settings",
];

const sweeps = [
  { theme: "light", viewport: "desktop" },
  { theme: "dark", viewport: "desktop" },
  { theme: "light", viewport: "phone" },
  { theme: "dark", viewport: "phone" },
  { theme: "dark", viewport: "phone", reducedMotion: true },
];

for (const sweep of sweeps) {
  scenario(caseName("app: every signed-in page loads cleanly", sweep), sweep, async ({ page, guard }) => {
    await signUpViaUi(page, { name: "Page Sweeper" });
    await completeOnboardingViaUi(page, { name: "Page Sweeper" });

    const failures = [];
    for (const path of APP_PAGES) {
      try {
        const response = await visit(page, path, { ready: "h1" });
        if (!response || response.status() !== 200) {
          throw new Error(`HTTP ${response ? response.status() : "no response"} for the page`);
        }
        await waitForSettled(page);
        await assertNoOverflow(page, path);
        // Each page is judged on its own: anything recorded since the last page belongs to this one.
        await guard.check(path);
        guard.problems.length = 0;
      } catch (error) {
        failures.push(`${path}: ${error.message.split("\n").slice(0, 6).join("\n    ")}`);
        guard.problems.length = 0;
      }
    }
    if (failures.length) throw new Error(`${failures.length} of ${APP_PAGES.length} pages failed:\n  ${failures.join("\n  ")}`);
  });
}

