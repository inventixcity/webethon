// Files: upload a generated PNG through the UI, see it appear, then delete it.
import assert from "node:assert/strict";
import { completeOnboardingViaUi, signUpViaUi } from "../lib/accounts.mjs";
import { THEMES, WEB_URL } from "../lib/config.mjs";
import { encodePng } from "../lib/png.mjs";
import { assertNoOverflow, caseName, scenario, visit } from "../lib/session.mjs";

const FILES = "/app/files";

/** A 96x64 PNG with a gradient and a stripe, so it is clearly a picture and not a blank tile. */
function testImage() {
  return encodePng(96, 64, (x, y) => (x % 16 < 8 ? [200, 60 + y, 40] : [30 + x, 120, 200]));
}

/** The file's card. Each uploaded file is an article with its name in a titled span. */
function cardFor(page, name) {
  return page.locator("article").filter({ has: page.locator(`span[title="${name}"]`) });
}

/** Lists the account's files through the API, using the browser context's session cookie. */
async function apiFileNames(context) {
  const response = await context.request.get(`${WEB_URL}/api/v1/files?limit=100`);
  assert.equal(response.status(), 200, "GET /api/v1/files should succeed");
  const body = await response.json();
  return body.data.map((file) => file.originalName);
}

for (const theme of THEMES) {
  scenario(caseName("files: upload a PNG, see it in the library, delete it", { theme }), { theme }, async ({ page, context }) => {
    await signUpViaUi(page, { name: "Picture Taker" });
    await completeOnboardingViaUi(page, { name: "Picture Taker" });
    await visit(page, FILES, { ready: "h1" });
    await page.locator('p[role="status"]').filter({ hasText: "Loading files" }).waitFor({ state: "detached" }).catch(() => {});

    const name = `browser-test-${Date.now().toString(36)}.png`;
    await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "image/png", buffer: testImage() });

    const card = cardFor(page, name);
    await card.waitFor({ state: "visible" });
    // The server re-encodes the image; wait for the thumbnail to actually decode, not just to exist.
    await card.locator('img[alt="Uploaded file"]').evaluate((image) =>
      image.complete ? image.naturalWidth > 0 : new Promise((resolve, reject) => {
        image.addEventListener("load", () => resolve(image.naturalWidth > 0));
        image.addEventListener("error", () => reject(new Error("thumbnail failed to load")));
      }),
    );
    assert.ok((await apiFileNames(context)).includes(name), "the API should list the uploaded file");
    await assertNoOverflow(page, "files library");

    page.once("dialog", (dialog) => dialog.accept());
    await card.getByRole("button", { name: "Delete", exact: true }).click();
    await card.waitFor({ state: "detached" });
    assert.ok(!(await apiFileNames(context)).includes(name), "the API should no longer list the deleted file");
  });
}

scenario(caseName("files: upload and delete on a phone-width screen", { theme: "light", viewport: "phone" }), { theme: "light", viewport: "phone" }, async ({ page }) => {
  await signUpViaUi(page, { name: "Phone Photo" });
  await completeOnboardingViaUi(page, { name: "Phone Photo" });
  await visit(page, FILES, { ready: "h1" });
  const name = `phone-${Date.now().toString(36)}.png`;
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "image/png", buffer: testImage() });
  await cardFor(page, name).waitFor({ state: "visible" });
  await assertNoOverflow(page, "files on a phone");
  page.once("dialog", (dialog) => dialog.accept());
  await cardFor(page, name).getByRole("button", { name: "Delete", exact: true }).click();
  await cardFor(page, name).waitFor({ state: "detached" });
});
