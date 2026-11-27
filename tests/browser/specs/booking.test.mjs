// Booking: create a resource with weekly hours, book a slot, see the slot go, then cancel the booking.
import assert from "node:assert/strict";
import { completeOnboardingViaUi, signUpViaUi, waitForPath } from "../lib/accounts.mjs";
import { THEMES } from "../lib/config.mjs";
import { assertNoOverflow, caseName, scenario, visit, waitForSettled } from "../lib/session.mjs";

/**
 * An open slot is a button that says how many seats are left, such as "1 seat left" or "3 seats left". The week
 * grid and the phone list both label slots this way, and a booked-out slot no longer says it.
 */
const OPEN_SLOT = /seats? left/;

function visibleSlots(page) {
  return page.getByRole("button", { name: OPEN_SLOT }).filter({ visible: true });
}

for (const theme of THEMES) {
  for (const viewport of ["desktop", "phone"]) {
    scenario(caseName("booking: create a resource with hours, book a slot, cancel it", { theme, viewport }), { theme, viewport }, async ({ page }) => {
      await signUpViaUi(page, { name: "Court Owner" });
      await completeOnboardingViaUi(page, { name: "Court Owner" });

      const resourceName = `Court ${Date.now().toString(36)}`;
      await visit(page, "/app/booking/new", { ready: "h1" });
      await page.getByLabel("Name", { exact: true }).fill(resourceName);
      await page.getByLabel("Slot length (minutes)", { exact: true }).fill("30");
      await page.getByLabel("Seats per slot", { exact: true }).fill("1");
      await page.getByRole("button", { name: "Create resource", exact: true }).click();
      await waitForPath(page, /^\/app\/booking\/[^/]+\/manage$/);
      const resourceId = new URL(page.url()).pathname.split("/")[3];

      // Open every day, 09:00 to 17:00, so the next week always has slots to book.
      await waitForSettled(page);
      // Each weekday has its own "Add hours" button, which stays visible and adds a 09:00 to 17:00 window.
      const addHours = page.getByRole("button", { name: "Add hours", exact: true });
      assert.equal(await addHours.count(), 7, "there should be one Add hours button per weekday");
      for (let index = 0; index < 7; index++) {
        await addHours.nth(index).click();
      }
      const save = page.getByRole("button", { name: "Save weekly hours", exact: true });
      await save.click();
      await page.getByText("Saved", { exact: true }).waitFor({ state: "visible" });
      await assertNoOverflow(page, "booking manage page");

      // The public page is where a visitor books. Pick the first open slot.
      await visit(page, `/app/booking/${resourceId}`, { ready: "h1" });
      await waitForSettled(page);
      const slot = visibleSlots(page).first();
      await slot.waitFor({ state: "visible" });
      const slotLabel = await slot.getAttribute("aria-label");
      await slot.click();

      // The confirm sheet opens for the slot.
      await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
      await page.getByText(/confirmed|booked/i).first().waitFor({ state: "visible" });
      await assertNoOverflow(page, "booking confirmation");

      // The booked slot leaves the calendar: it has no seats left.
      await visit(page, `/app/booking/${resourceId}`, { ready: "h1" });
      await waitForSettled(page);
      await page.getByRole("button", { name: slotLabel, exact: true }).first().waitFor({ state: "detached" });

      // Cancel it from the bookings page.
      await visit(page, "/app/booking/bookings", { ready: "h1" });
      await waitForSettled(page);
      const row = page.locator("li, article").filter({ hasText: resourceName }).first();
      await row.getByRole("button", { name: /^Cancel/ }).click();
      await row.getByRole("button", { name: "Yes, cancel", exact: true }).click();
      // The status is part of a longer line ("1 seat · Cancelled"), so match the word rather than the whole text.
      await row.getByText(/Cancelled/).first().waitFor({ state: "visible" });
    });
  }
}
