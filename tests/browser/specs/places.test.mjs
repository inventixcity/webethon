// Places: the map canvas draws something, and a place added through the form shows up in the list.
import assert from "node:assert/strict";
import { completeOnboardingViaUi, signUpViaUi } from "../lib/accounts.mjs";
import { THEMES } from "../lib/config.mjs";
import { decodePng, visibleFraction } from "../lib/png.mjs";
import { assertNoOverflow, caseName, scenario, visit, waitForSettled } from "../lib/session.mjs";
import { eventually } from "../lib/wait.mjs";

const PLACES = "/app/places";

/** The map is a WebGL canvas with role "region" and the label "Map". Screenshots show what it actually drew. */
function mapCanvas(page) {
  return page.getByRole("region", { name: "Map", exact: true });
}

/** Fraction of the canvas that isn't the single most common colour. A blank map scores 0. */
async function mapVisibleFraction(page) {
  const png = await mapCanvas(page).screenshot();
  return visibleFraction(decodePng(png));
}

for (const theme of THEMES) {
  for (const viewport of ["desktop", "phone"]) {
    scenario(caseName("places: the map renders and a new place appears in the list", { theme, viewport }), { theme, viewport }, async ({ page }) => {
      await signUpViaUi(page, { name: "Map Maker" });
      await completeOnboardingViaUi(page, { name: "Map Maker" });
      await visit(page, PLACES, { ready: "h1" });
      await waitForSettled(page);

      await mapCanvas(page).waitFor({ state: "visible" });
      const fraction = await eventually(
        async () => {
          const value = await mapVisibleFraction(page);
          return value > 0.02 ? value : false;
        },
        { timeout: 60_000, message: "the map canvas stayed blank" },
      );
      assert.ok(fraction > 0.02);
      await assertNoOverflow(page, "places map");

      const name = `Browser Cafe ${Date.now().toString(36)}`;
      await page.getByRole("button", { name: "Add place", exact: true }).first().click();
      const form = page.locator("#place-editor");
      await form.getByLabel("Name", { exact: true }).fill(name);
      await form.getByLabel("Category", { exact: true }).fill("cafe");
      // A place needs a position. "Pick on map" then a click on the map sets the latitude and longitude.
      await form.getByRole("button", { name: "Pick on map", exact: true }).click();
      await mapCanvas(page).click({ position: { x: 200, y: 150 } });
      await eventually(async () => (await form.getByLabel("Latitude", { exact: true }).inputValue()) !== "", {
        timeout: 15_000,
        message: "picking a point on the map did not fill the latitude",
      });
      await form.getByRole("button", { name: "Add place", exact: true }).click();

      await page.getByRole("button", { name: new RegExp(name) }).first().waitFor({ state: "visible" });
      await assertNoOverflow(page, "places list after adding");
    });
  }
}
