// Records: create, edit and delete a note through the UI, and see a change arrive live in a second tab.
import assert from "node:assert/strict";
import { completeOnboardingViaUi, signUpViaUi } from "../lib/accounts.mjs";
import { THEMES } from "../lib/config.mjs";
import { assertNoOverflow, caseName, scenario, visit, watch } from "../lib/session.mjs";

const NOTES = "/app/data/notes";

/** Waits until the list has finished loading (skeletons are shown while it does). */
async function waitForListReady(page) {
  await page.waitForFunction(() => !document.querySelector('[aria-label="Loading records"]'));
}

async function newAccountOnNotes(page) {
  await signUpViaUi(page, { name: "Note Taker" });
  await completeOnboardingViaUi(page, { name: "Note Taker" });
  await visit(page, NOTES, { ready: "h1" });
  await waitForListReady(page);
}

/** The editor is a modal dialog with a labelled title. Submit it with the "Save record" button. */
function editor(page) {
  return page.locator('[role="dialog"][aria-labelledby="editor-title"]');
}

for (const theme of THEMES) {
  for (const viewport of ["desktop", "phone"]) {
    scenario(caseName("data: create, edit and delete a note through the UI", { theme, viewport }), { theme, viewport }, async ({ page }) => {
      await newAccountOnNotes(page);
      await assertNoOverflow(page, "notes list");

      const title = `Groceries ${Date.now().toString(36)}`;
      await page.getByRole("button", { name: "+ New record" }).click();
      await editor(page).waitFor({ state: "visible" });
      await editor(page).getByLabel(/^Title/).fill(title);
      await editor(page).getByRole("button", { name: "Save record" }).click();
      await editor(page).waitFor({ state: "detached" });
      await page.getByText(title, { exact: true }).first().waitFor({ state: "visible" });

      // Select the note to focus it; the focused panel offers Edit and Delete.
      await page.getByText(title, { exact: true }).first().click();
      // Only one record is focused at a time, so its Edit and Delete buttons are the only ones on the page.
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await editor(page).waitFor({ state: "visible" });
      const renamed = `${title} (edited)`;
      await editor(page).getByLabel(/^Title/).fill(renamed);
      await editor(page).getByRole("button", { name: "Save record" }).click();
      await editor(page).waitFor({ state: "detached" });
      await page.getByText(renamed, { exact: true }).first().waitFor({ state: "visible" });

      await page.getByText(renamed, { exact: true }).first().click();
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByText(renamed, { exact: true }).first().waitFor({ state: "detached" });
    });
  }
}

for (const theme of THEMES) {
  scenario(caseName("data: a note created in one tab appears in a second tab without reloading", { theme }), { theme }, async ({ page, context }) => {
    await newAccountOnNotes(page);
    await page.getByRole("status").filter({ hasText: "Live" }).first().waitFor({ state: "visible" });

    const other = await context.newPage();
    other.setDefaultTimeout(45_000);
    other.setDefaultNavigationTimeout(90_000);
    const otherGuard = watch(other);
    await visit(other, NOTES, { ready: "h1" });
    await waitForListReady(other);
    await other.getByRole("status").filter({ hasText: "Live" }).first().waitFor({ state: "visible" });

    const title = `Live note ${Date.now().toString(36)}`;
    await other.getByRole("button", { name: "+ New record" }).click();
    await editor(other).waitFor({ state: "visible" });
    await editor(other).getByLabel(/^Title/).fill(title);
    await editor(other).getByRole("button", { name: "Save record" }).click();

    // The first tab was never reloaded: the change has to arrive over the live connection.
    await page.getByText(title, { exact: true }).first().waitFor({ state: "visible" });
    await other.close();
    await otherGuard.check("second tab");
    assert.equal(new URL(page.url()).pathname, NOTES);
  });
}
