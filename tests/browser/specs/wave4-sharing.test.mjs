// Sharing: outbound webhooks and public share links in settings, the Share dialog on a note, and the public page.
import assert from "node:assert/strict";
import { completeOnboardingViaUi, signUpViaUi } from "../lib/accounts.mjs";
import { THEMES, WEB_URL } from "../lib/config.mjs";
import { assertNoOverflow, caseName, openPage, scenario, visit, waitForSettled } from "../lib/session.mjs";
import { assertNoInfiniteAnimation } from "../lib/wave4.mjs";

const NOTES = "/app/data/notes";
const SETTINGS = "/app/settings";
/** A public address the server can resolve. Test sends to it are answered or refused, and both show a toast. */
const WEBHOOK_URL = "https://example.com/hooks/records";
const SECRET_LEAD = "Copy it now. It won't be shown again.";
const NO_WEBHOOKS = "No webhooks yet. Add one to have your own server receive signed events as they happen.";
const NO_SHARES = "You haven't shared any records yet. Open a record and choose Share to make a public link.";
// The page heading carries the status code for screen readers ("410: This link is gone."), so match the sentence.
const GONE = /This link is gone\./;

const sweeps = [
  { theme: "light", viewport: "desktop" },
  { theme: "dark", viewport: "desktop" },
  { theme: "light", viewport: "phone" },
  { theme: "dark", viewport: "phone" },
  { theme: "dark", viewport: "phone", reducedMotion: true },
];

const webhooksSection = (page) => page.locator("#webhooks");
const shareLinksSection = (page) => page.locator("#share-links");

async function signUpAndOnboard(page, name) {
  await signUpViaUi(page, { name });
  await completeOnboardingViaUi(page, { name });
}

async function openSettings(page) {
  await visit(page, SETTINGS, { ready: "h1" });
  await waitForSettled(page);
}

/** Opens the add form in the Webhooks section, fills it, and ticks one record event. Returns the form. */
async function fillWebhookForm(page, { url = WEBHOOK_URL, description, event = "Created" } = {}) {
  await openSettings(page);
  const section = webhooksSection(page);
  await section.getByRole("button", { name: "Add webhook", exact: true }).click();
  const form = section.locator("form");
  await form.getByLabel("Address", { exact: true }).fill(url);
  if (description) await form.getByLabel("Description (optional)", { exact: true }).fill(description);
  await form.getByRole("group", { name: "Note", exact: true }).getByRole("checkbox", { name: event, exact: true }).check();
  return form;
}

/** Creates a webhook with the default values and waits for its secret panel. Returns the secret panel. */
async function createWebhook(page, options) {
  const form = await fillWebhookForm(page, options);
  await form.getByRole("button", { name: "Create webhook", exact: true }).click();
  const panel = page.locator('section[aria-label^="Signing secret for"]');
  await panel.waitFor({ state: "visible" });
  return panel;
}

/** The row for the webhook at WEBHOOK_URL. */
function webhookRow(page) {
  return webhooksSection(page).locator("li").filter({ hasText: WEBHOOK_URL });
}

async function createNote(page, title) {
  await visit(page, NOTES, { ready: "h1" });
  await page.waitForFunction(() => !document.querySelector('[aria-label="Loading records"]'));
  await page.getByRole("button", { name: "+ New record", exact: true }).click();
  const editor = page.locator('[role="dialog"][aria-labelledby="editor-title"]');
  await editor.waitFor({ state: "visible" });
  await editor.getByLabel(/^Title/).fill(title);
  await editor.getByRole("button", { name: "Save record", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  await page.getByText(title, { exact: true }).first().waitFor({ state: "visible" });
}

/**
 * Opens the Share dialog from the note's own card. Every card has its own Share button, so the click is scoped to the
 * card that holds this note's title.
 */
async function openShareDialog(page, title) {
  await page.getByRole("article").filter({ hasText: title }).getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share this record", exact: true });
  await dialog.waitFor({ state: "visible" });
  return dialog;
}

/** Creates the link with the dialog's current expiry, and returns the dialog and the link. */
async function createLink(dialog) {
  await dialog.getByRole("button", { name: "Create link", exact: true }).click();
  const url = dialog.getByLabel("Public link", { exact: true });
  await url.waitFor({ state: "visible" });
  return { dialog, url: await url.inputValue() };
}

/** Opens the dialog and creates a link with the default expiry. */
async function createShareLink(page, title) {
  return createLink(await openShareDialog(page, title));
}

/** Opens a link in a fresh, signed-out browser and checks it shows the record title, and asks not to be indexed. */
async function assertPublicRecord(theme, url, title) {
  const visitor = await openPage({ theme });
  try {
    const response = await visitor.page.goto(url, { waitUntil: "domcontentloaded" });
    assert.equal(response.status(), 200, `the public link should answer 200, got ${response.status()}`);
    await visitor.page.getByRole("heading", { name: title, exact: true }).waitFor({ state: "visible" });
    const robots = await visitor.page.locator('meta[name="robots"]').getAttribute("content");
    assert.match(robots ?? "", /noindex/, "the public record asks search engines not to index it");
    await visitor.guard.check("public record");
  } finally {
    await visitor.close();
  }
}

/** Opens a link in a fresh, signed-out browser and checks the gone page. Accepts the page's own status, 200 or 410. */
async function assertGonePage(theme, urlOrPath) {
  const visitor = await openPage({ theme });
  try {
    const response = await visitor.page.goto(new URL(urlOrPath, WEB_URL).href, { waitUntil: "domcontentloaded" });
    assert.ok([200, 410].includes(response.status()), `the gone page should answer 200 or 410, got ${response.status()}`);
    await visitor.page.getByRole("heading", { name: GONE }).waitFor({ state: "visible" });
    const robots = await visitor.page.locator('meta[name="robots"]').getAttribute("content");
    assert.match(robots ?? "", /noindex/, "the gone page asks search engines not to index it");
    await visitor.guard.check("gone page");
  } finally {
    await visitor.close();
  }
}

for (const theme of THEMES) {
  scenario(caseName("settings webhooks: create one, the secret is shown once with a copy button, and not again after a reload", { theme }), { theme }, async ({ page }) => {
    await signUpAndOnboard(page, "Hook Maker");
    // Copy needs clipboard permission in this browser context; the copy button itself is what the test exercises.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: WEB_URL });

    const panel = await createWebhook(page, { description: "Browser test endpoint" });
    await panel.getByText(SECRET_LEAD, { exact: true }).waitFor({ state: "visible" });
    const secret = (await panel.locator("code").innerText()).trim();
    assert.match(secret, /^whsec_/, "the secret is shown in full");

    await panel.getByRole("button", { name: "Copy secret", exact: true }).click();
    await panel.getByRole("button", { name: "Copied", exact: true }).waitFor({ state: "visible" });

    await panel.getByRole("button", { name: "I've saved it", exact: true }).click();
    await panel.waitFor({ state: "detached" });

    // After leaving the panel and reloading, the webhook is listed without its secret.
    await openSettings(page);
    await webhookRow(page).waitFor({ state: "visible" });
    assert.equal(await page.getByText(SECRET_LEAD, { exact: true }).count(), 0, "the secret panel does not come back");
    assert.equal((await page.content()).includes(secret), false, "the secret is not stored in the page after a reload");
    await assertNoOverflow(page, "webhooks after reload");
  });
}

for (const theme of THEMES) {
  scenario(caseName("settings webhooks: an invalid address shows its error on the address field, not a toast", { theme }), { theme }, async ({ page }) => {
    await signUpAndOnboard(page, "Bad Address");
    const form = await fillWebhookForm(page, { url: "not a web address" });
    await form.getByRole("button", { name: "Create webhook", exact: true }).click();

    const address = form.getByLabel("Address", { exact: true });
    await form.locator('input[aria-invalid="true"]').waitFor({ state: "visible" });
    const errorId = await address.getAttribute("aria-describedby");
    assert.ok(errorId, "the address field points at its error");
    const message = page.locator(`[id="${errorId}"]`);
    await message.waitFor({ state: "visible" });
    assert.ok((await message.innerText()).trim().length > 0, "the field error has words in it");

    // The problem stays with the field: no error toast is shown as well.
    assert.equal(await page.locator('[aria-live="polite"] [role="alert"]').count(), 0, "the error is not also a toast");
  });
}

for (const theme of THEMES) {
  scenario(caseName("settings webhooks: send test shows the result as a toast, and the deliveries open", { theme }), { theme }, async ({ page }) => {
    await signUpAndOnboard(page, "Test Sender");
    await createWebhook(page, { description: "Test send" });
    const row = webhookRow(page);

    await row.getByRole("button", { name: "Send test", exact: true }).click();
    // The result is one of the toast sentences, depending on what the endpoint answered.
    await page
      .getByText(/(Test delivered\. |Test sent\. |The test didn't reach your endpoint|The test got a \d+ response)/)
      .first()
      .waitFor({ state: "visible" });

    await row.getByRole("button", { name: "View deliveries", exact: true }).click();
    await row.getByRole("button", { name: "Hide deliveries", exact: true }).waitFor({ state: "visible" });
    // The deliveries open as a table. An endpoint with no deliveries yet shows the empty words instead.
    const table = row.getByRole("table", { name: "Recent deliveries for this webhook", exact: true });
    const empty = row.getByText("No deliveries yet. Send a test, or wait for an event.", { exact: true });
    await table.or(empty).first().waitFor({ state: "visible" });
  });
}

for (const theme of THEMES) {
  scenario(caseName("settings webhooks: delete asks for confirm, and Cancel keeps the webhook", { theme }), { theme }, async ({ page }) => {
    await signUpAndOnboard(page, "Hook Deleter");
    await createWebhook(page);
    const row = webhookRow(page);

    await row.getByRole("button", { name: "Delete", exact: true }).click();
    const question = row.getByRole("group", { name: /^Delete this webhook\?/ });
    await question.waitFor({ state: "visible" });
    await question.getByRole("button", { name: "Cancel", exact: true }).click();
    await question.waitFor({ state: "detached" });
    await row.waitFor({ state: "visible" });

    await row.getByRole("button", { name: "Delete", exact: true }).click();
    await question.getByRole("button", { name: "Delete webhook", exact: true }).click();
    await webhooksSection(page).getByText(NO_WEBHOOKS, { exact: true }).waitFor({ state: "visible" });
  });
}

for (const theme of THEMES) {
  scenario(caseName("settings share links: a new account sees the empty state in plain words", { theme }), { theme }, async ({ page }) => {
    await signUpAndOnboard(page, "No Shares");
    await openSettings(page);
    await shareLinksSection(page).getByText(NO_SHARES, { exact: true }).waitFor({ state: "visible" });
    await assertNoOverflow(page, "share links, empty");
  });
}

for (const theme of THEMES) {
  scenario(caseName("settings share links: revoke asks for confirm, and a revoked link shows the gone page", { theme }), { theme }, async ({ page }) => {
    await signUpAndOnboard(page, "Link Revoker");
    const title = `Shared ${Date.now().toString(36)}`;
    await createNote(page, title);
    const { dialog, url } = await createShareLink(page, title);
    await dialog.getByRole("button", { name: "Done", exact: true }).click();

    await openSettings(page);
    const item = shareLinksSection(page).locator("li").first();
    await item.getByRole("button", { name: "Revoke", exact: true }).click();
    const question = page.getByRole("group", { name: /^Revoke this link\?/ });
    await question.waitFor({ state: "visible" });
    await question.getByRole("button", { name: "Cancel", exact: true }).click();
    await question.waitFor({ state: "detached" });
    await item.waitFor({ state: "visible" });

    await item.getByRole("button", { name: "Revoke", exact: true }).click();
    await question.getByRole("button", { name: "Revoke link", exact: true }).click();
    await page.getByText("Link revoked. It no longer opens.", { exact: true }).waitFor({ state: "visible" });
    await shareLinksSection(page).getByText(NO_SHARES, { exact: true }).waitFor({ state: "visible" });

    await assertGonePage(theme, url);
  });
}

for (const theme of THEMES) {
  scenario(caseName("record share: Share opens the dialog with 1, 7, 30, 90 days, and the link opens the record", { theme }), { theme }, async ({ page }) => {
    await signUpAndOnboard(page, "Sharer");
    const title = `Public note ${Date.now().toString(36)}`;
    await createNote(page, title);

    const dialog = await openShareDialog(page, title);
    const expiry = dialog.getByLabel("Link expires after", { exact: true });
    assert.deepEqual(await expiry.locator("option").allTextContents(), ["1 day", "7 days", "30 days", "90 days"]);
    assert.equal(await expiry.inputValue(), "30", "30 days is the default");

    const { url } = await createLink(dialog);
    assert.match(url, /\/s\/[A-Za-z0-9_-]+$/, "the link is a /s/ address");
    await dialog.getByRole("button", { name: "Copy link", exact: true }).waitFor({ state: "visible" });
    const expiresLine = dialog.getByRole("status").filter({ hasText: "Expires on" });
    await expiresLine.waitFor({ state: "visible" });
    assert.match(await expiresLine.innerText(), /Expires on .+\d{4}\.$/, "the expiry date is shown");

    await assertPublicRecord(theme, url, title);
  });
}

for (const theme of THEMES) {
  scenario(caseName("public: /s/invalidtoken shows the gone page, and asks search engines not to index it", { theme }), { theme }, async ({ page }) => {
    const response = await visit(page, "/s/invalidtoken", { ready: "h1" });
    assert.ok([200, 410].includes(response.status()), `the gone page should answer 200 or 410, got ${response.status()}`);
    await page.getByRole("heading", { name: GONE }).waitFor({ state: "visible" });
    const robots = await page.locator('meta[name="robots"]').getAttribute("content");
    assert.match(robots ?? "", /noindex/, "the gone page asks search engines not to index it");
    await assertNoOverflow(page, "/s/invalidtoken");
  });
}

// Every sharing page loads cleanly for a signed-in person. The last sweep also runs under reduced motion.
for (const sweep of sweeps) {
  scenario(
    caseName("sharing: settings and the public gone page load cleanly, with no overflow", sweep),
    sweep,
    async ({ page, guard }) => {
      await signUpAndOnboard(page, "Sweeper");

      const failures = [];
      for (const path of [SETTINGS, "/s/invalidtoken"]) {
        try {
          const response = await visit(page, path, { ready: "h1" });
          if (![200, 410].includes(response.status())) throw new Error(`HTTP ${response.status()} for the page`);
          await waitForSettled(page);
          await assertNoOverflow(page, path);
          if (sweep.reducedMotion) await assertNoInfiniteAnimation(page, path);
          await guard.check(path);
        } catch (error) {
          failures.push(`${path}: ${error.message.split("\n").slice(0, 6).join("\n    ")}`);
        }
        // Each page is judged on its own: anything recorded since the last page belongs to this one.
        guard.problems.length = 0;
      }
      if (failures.length) throw new Error(`${failures.length} sharing pages failed:\n  ${failures.join("\n  ")}`);
    },
  );
}
