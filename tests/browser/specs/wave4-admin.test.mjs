// Admin screens for background jobs and feature flags. A normal user gets the 404 page. An admin gets the working screens.
import assert from "node:assert/strict";
import { completeOnboardingViaUi, signUpViaUi } from "../lib/accounts.mjs";
import { ADMIN_PASSWORD, THEMES } from "../lib/config.mjs";
import { assertNoOverflow, caseName, scenario, visit, waitForSettled } from "../lib/session.mjs";
import { ADMIN_SKIP_REASON, assertNoInfiniteAnimation, hideDevKitNav, signInAsAdmin } from "../lib/wave4.mjs";

const JOBS = "/admin/jobs";
const FLAGS = "/admin/flags";
const ADMIN_PAGES = [JOBS, FLAGS];

/** The 404 page's headline (components/errors/copy.ts). */
const NOT_FOUND_HEADLINE = "This page has been eaten.";
const EMPTY_JOBS = "No results found. Try changing the filters.";
const KEY_MESSAGE = "Use lowercase letters, digits, dots and dashes only.";
const JSON_MESSAGE = "The value isn't valid JSON. Check brackets, quotes and commas.";
const EMAIL_MESSAGE = `"not-an-email" isn't a valid email address.`;

const sweeps = [
  { theme: "light", viewport: "desktop" },
  { theme: "dark", viewport: "desktop" },
  { theme: "light", viewport: "phone" },
  { theme: "dark", viewport: "phone" },
  { theme: "dark", viewport: "phone", reducedMotion: true },
];

/** A flag key unique to this run: lowercase letters, digits, dots and dashes, as the editor requires. */
function newFlagKey(label) {
  return `wave4.${label}-${Date.now().toString(36)}`;
}

/** Opens the editor for a new flag and returns its drawer. */
async function openNewFlag(page) {
  await visit(page, FLAGS, { ready: "h1" });
  await waitForSettled(page);
  await hideDevKitNav(page);
  await page.getByRole("button", { name: "New flag", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "New flag", exact: true });
  await drawer.waitFor({ state: "visible" });
  return drawer;
}

/** Saving or deleting asks for step-up. This answers the password prompt, then the dialog closes. */
async function verifyStepUp(page) {
  const verify = page.getByRole("dialog", { name: "Verify your identity", exact: true });
  await verify.waitFor({ state: "visible" });
  await verify.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await verify.getByRole("button", { name: "Verify", exact: true }).click();
  await verify.waitFor({ state: "detached" });
}

/** Creates a flag through the editor: the first save asks for step-up, and the second save applies the change. */
async function createFlag(page, key) {
  const drawer = await openNewFlag(page);
  await drawer.getByLabel("Key", { exact: true }).fill(key);
  await drawer.getByRole("button", { name: "Save flag", exact: true }).click();
  await verifyStepUp(page);
  await drawer.getByRole("button", { name: "Save flag", exact: true }).click();
  await page.getByText("Flag saved.", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("cell", { name: key, exact: true }).waitFor({ state: "visible" });
}

/** Opens a flag from the list and deletes it: the confirm dialog comes first. Step-up is already verified here. */
async function deleteFlag(page, key) {
  await page.getByRole("cell", { name: key, exact: true }).click();
  const drawer = page.getByRole("dialog", { name: key, exact: true });
  await drawer.getByRole("button", { name: "Delete flag", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Delete flag", exact: true });
  await confirm.getByRole("button", { name: "Delete flag", exact: true }).click();
  await page.getByText("Flag deleted.", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("cell", { name: key, exact: true }).waitFor({ state: "detached" });
}

// A normal user is not an admin, so both admin screens are the 404 page.
for (const theme of THEMES) {
  // Each admin path answers 404 on purpose, and the browser logs that response. Only that exact one is expected.
  const expectStatus = ADMIN_PAGES.map((path) => ({ path, status: 404 }));
  scenario(caseName("admin: /admin/jobs and /admin/flags are the 404 page for a normal user", { theme }), { theme, expectStatus }, async ({ page }) => {
    await signUpViaUi(page, { name: "Plain User" });
    await completeOnboardingViaUi(page, { name: "Plain User" });

    for (const path of ADMIN_PAGES) {
      const response = await visit(page, path, { ready: "h1" });
      assert.equal(response.status(), 404, `${path} should answer 404 for a normal user`);
      // Not exact: the title carries a visually hidden "404: " prefix, so its accessible name is "404: <headline>".
      await page.getByRole("heading", { name: NOT_FOUND_HEADLINE }).waitFor({ state: "visible" });
      await assertNoOverflow(page, path);
    }
  });
}

// Every admin screen loads for an admin, with no console errors and no overflow. The last sweep also runs under
// reduced motion, and checks that no looping animation is running.
for (const sweep of sweeps) {
  scenario(
    caseName("admin: /admin/jobs and /admin/flags load cleanly, with no overflow", sweep),
    sweep,
    async ({ page, guard }) => {
      await signInAsAdmin(page);

      const failures = [];
      for (const path of ADMIN_PAGES) {
        try {
          const response = await visit(page, path, { ready: "h1" });
          if (response.status() !== 200) throw new Error(`HTTP ${response.status()} for the page`);
          await waitForSettled(page);
          await hideDevKitNav(page);
          await assertNoOverflow(page, path);
          if (sweep.reducedMotion) await assertNoInfiniteAnimation(page, path);
          await guard.check(path);
        } catch (error) {
          failures.push(`${path}: ${error.message.split("\n").slice(0, 6).join("\n    ")}`);
        }
        // Each page is judged on its own: anything recorded since the last page belongs to this one.
        guard.problems.length = 0;
      }
      if (failures.length) throw new Error(`${failures.length} of ${ADMIN_PAGES.length} admin pages failed:\n  ${failures.join("\n  ")}`);
    },
    { skip: ADMIN_SKIP_REASON },
  );
}

for (const theme of THEMES) {
  scenario(
    caseName("admin jobs: the status and kind filters, the list or empty state, and Next only when there is a next page", { theme }),
    { theme },
    async ({ page }) => {
      await signInAsAdmin(page);
      await visit(page, JOBS, { ready: "h1" });
      await waitForSettled(page);

      await page.getByLabel("Status", { exact: true }).waitFor({ state: "visible" });
      await page.getByLabel("Kind", { exact: true }).waitFor({ state: "visible" });
      await page.getByRole("button", { name: "Apply filters", exact: true }).waitFor({ state: "visible" });

      const table = page.getByRole("table");
      await table.or(page.getByText(EMPTY_JOBS, { exact: true })).first().waitFor({ state: "visible" });
      if (!(await table.isVisible())) {
        // No jobs yet: the empty state shows and no pager is drawn at all.
        assert.equal(await page.getByRole("button", { name: "Next", exact: true }).count(), 0, "no pager without rows");
        return;
      }

      // The pager only moves forward when the server gave a next cursor. Its Next control stays off on the last page.
      const next = page.getByRole("button", { name: "Next", exact: true });
      const previous = page.getByRole("button", { name: "Previous", exact: true });
      if (await next.isEnabled()) {
        await next.click();
        await waitForSettled(page);
        assert.equal(await previous.isEnabled(), true, "Previous is on once a second page is open");
        await previous.click();
        await waitForSettled(page);
      } else {
        assert.equal(await previous.isEnabled(), false, "Previous is off on the first page");
      }
    },
    { skip: ADMIN_SKIP_REASON },
  );

  scenario(
    caseName("admin jobs: filtering by status shows only jobs with that status", { theme }),
    { theme },
    async ({ page }) => {
      await signInAsAdmin(page);
      await visit(page, JOBS, { ready: "h1" });
      await waitForSettled(page);

      // Wait for the filtered request itself, so the old rows are not what gets checked.
      await page.getByLabel("Status", { exact: true }).selectOption("failed");
      await Promise.all([
        page.waitForResponse((response) => response.url().includes("/api/v1/admin/jobs") && response.url().includes("status=failed")),
        page.getByRole("button", { name: "Apply filters", exact: true }).click(),
      ]);
      await waitForSettled(page);

      const table = page.getByRole("table");
      await table.or(page.getByText(EMPTY_JOBS, { exact: true })).first().waitFor({ state: "visible" });
      if (await table.isVisible()) {
        // The status is the second column. Every row that is left must read "Failed".
        const statuses = (await table.locator("tbody tr td:nth-child(2)").allTextContents()).map((text) => text.trim());
        assert.ok(statuses.length > 0, "the filtered table has rows");
        for (const status of statuses) assert.equal(status, "Failed", "every row matches the status filter");
      }
    },
    { skip: ADMIN_SKIP_REASON },
  );
}

for (const theme of THEMES) {
  scenario(
    caseName("admin flags: an invalid key shows a field error on the key, and nothing is sent", { theme }),
    { theme },
    async ({ page }) => {
      await signInAsAdmin(page);
      const drawer = await openNewFlag(page);
      const keyInput = drawer.getByLabel("Key", { exact: true });
      await keyInput.fill("Bad_Key");
      await drawer.getByRole("button", { name: "Save flag", exact: true }).click();

      const error = page.locator("#flag-key-error");
      await error.waitFor({ state: "visible" });
      assert.equal((await error.innerText()).trim(), KEY_MESSAGE);
      assert.equal(await keyInput.getAttribute("aria-invalid"), "true", "the key field is marked invalid");
      assert.equal(await page.getByRole("dialog", { name: "Verify your identity", exact: true }).count(), 0, "no step-up: the save never reached the server");
    },
    { skip: ADMIN_SKIP_REASON },
  );

  scenario(
    caseName("admin flags: invalid JSON in the value shows a field error on the value", { theme }),
    { theme },
    async ({ page }) => {
      await signInAsAdmin(page);
      const drawer = await openNewFlag(page);
      await drawer.getByLabel("Key", { exact: true }).fill(newFlagKey("json"));
      await drawer.getByLabel("Value (JSON)", { exact: true }).fill("{not json");
      await drawer.getByRole("button", { name: "Save flag", exact: true }).click();

      const error = page.locator("#flag-value-error");
      await error.waitFor({ state: "visible" });
      assert.equal((await error.innerText()).trim(), JSON_MESSAGE);
      assert.equal(await drawer.getByLabel("Value (JSON)", { exact: true }).getAttribute("aria-invalid"), "true");
    },
    { skip: ADMIN_SKIP_REASON },
  );

  scenario(
    caseName("admin flags: an invalid email in the allow list shows a field error on that field", { theme }),
    { theme },
    async ({ page }) => {
      await signInAsAdmin(page);
      const drawer = await openNewFlag(page);
      await drawer.getByLabel("Key", { exact: true }).fill(newFlagKey("email"));
      await drawer.getByLabel("Allowed emails", { exact: true }).fill("not-an-email");
      await drawer.getByRole("button", { name: "Save flag", exact: true }).click();

      const error = page.locator("#flag-allow-emails-error");
      await error.waitFor({ state: "visible" });
      assert.equal((await error.innerText()).trim(), EMAIL_MESSAGE);
    },
    { skip: ADMIN_SKIP_REASON },
  );

  scenario(
    caseName("admin flags: a valid key asks for step-up on save, then saves and can be removed", { theme }),
    { theme },
    async ({ page }) => {
      await signInAsAdmin(page);
      const key = newFlagKey("create");
      // createFlag asserts the step-up dialog appears on the first save.
      await createFlag(page, key);
      await deleteFlag(page, key);
    },
    { skip: ADMIN_SKIP_REASON },
  );

  scenario(
    caseName("admin flags: delete asks for confirm first, and Cancel keeps the flag", { theme }),
    { theme },
    async ({ page }) => {
      await signInAsAdmin(page);
      const key = newFlagKey("delete");
      await createFlag(page, key);

      await page.getByRole("cell", { name: key, exact: true }).click();
      const drawer = page.getByRole("dialog", { name: key, exact: true });
      await drawer.getByRole("button", { name: "Delete flag", exact: true }).click();
      const confirm = page.getByRole("dialog", { name: "Delete flag", exact: true });
      await confirm.waitFor({ state: "visible" });
      await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
      await confirm.waitFor({ state: "detached" });
      await drawer.waitFor({ state: "visible" });
      assert.equal(await page.getByText("Flag deleted.", { exact: true }).count(), 0, "nothing was deleted by Cancel");

      // The confirm is the only path that deletes: remove it through the dialog now.
      await drawer.getByRole("button", { name: "Delete flag", exact: true }).click();
      await confirm.getByRole("button", { name: "Delete flag", exact: true }).click();
      await page.getByText("Flag deleted.", { exact: true }).waitFor({ state: "visible" });
      await page.getByRole("cell", { name: key, exact: true }).waitFor({ state: "detached" });
    },
    { skip: ADMIN_SKIP_REASON },
  );
}
