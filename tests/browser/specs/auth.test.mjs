// Sign-up, sign-in, sign-out, password reset and the design previews.
import assert from "node:assert/strict";
import { enterCode, signInViaUi, signOutViaUi, signUpViaUi, waitForPath } from "../lib/accounts.mjs";
import { THEMES } from "../lib/config.mjs";
import { messageIds, waitForCode } from "../lib/mail.mjs";
import { assertNoOverflow, caseName, scenario, visit } from "../lib/session.mjs";

const VIEWPORT_NAMES = ["desktop", "phone"];

for (const theme of THEMES) {
  for (const viewport of VIEWPORT_NAMES) {
    scenario(caseName("auth: sign up, verify the emailed code, land under /app", { theme, viewport }), { theme, viewport }, async ({ page }) => {
      await visit(page, "/signup", { ready: "form" });
      await assertNoOverflow(page, "sign-up page");
      await signUpViaUi(page);
      // A new account has not finished onboarding, so the app sends it there rather than to the dashboard.
      assert.equal(new URL(page.url()).pathname, "/app/onboarding");
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      await assertNoOverflow(page, "app after sign-up");
    });
  }
}

for (const theme of THEMES) {
  scenario(caseName("auth: wrong password shows the error and keeps the visitor on the form", { theme }), { theme }, async ({ page }) => {
    const account = await signUpViaUi(page);
    await signOutViaUi(page);
    await signInViaUi(page, { email: account.email, password: "Not the right password 1!" });
    await page.getByText("That email and password don't match.").waitFor({ state: "visible" });
    assert.equal(new URL(page.url()).pathname, "/login");
  });
}

for (const theme of THEMES) {
  scenario(caseName("auth: sign out returns to login, and /app then redirects to login", { theme }), { theme }, async ({ page }) => {
    await signUpViaUi(page);
    await signOutViaUi(page);
    await visit(page, "/app", { ready: "form" });
    await waitForPath(page, /^\/login$/);
    assert.equal(new URL(page.url()).searchParams.get("next"), "/app", "the redirect should remember where the visitor was going");
  });
}

for (const theme of THEMES) {
  scenario(caseName("auth: forgot password, emailed code, new password, then sign in with it", { theme }), { theme }, async ({ page }) => {
    const account = await signUpViaUi(page);
    await signOutViaUi(page);

    await visit(page, "/forgot-password", { ready: "form" });
    const before = await messageIds(account.email);
    // The forgot-password form labels its field "Email address" in one design set and "Email" in another.
    await page.locator('input[type="email"]').first().fill(account.email);
    await page.getByRole("button", { name: "Send reset code" }).click();
    await page.getByRole("link", { name: "Enter the code" }).click();
    await waitForPath(page, /^\/verify$/);

    const code = await waitForCode(account.email, before);
    await enterCode(page, code);
    await waitForPath(page, /^\/reset-password$/);

    const newPassword = "A different passphrase 2!";
    await page.getByLabel("New password", { exact: true }).fill(newPassword);
    await page.getByLabel("Type it again", { exact: true }).fill(newPassword);
    await page.getByRole("button", { name: "Save password" }).click();
    // The reset signs the visitor in, so the app (or onboarding for an unfinished account) follows.
    await waitForPath(page, /^\/app(\/|$)/);

    await signOutViaUi(page);
    await signInViaUi(page, { email: account.email, password: newPassword });
    await waitForPath(page, /^\/app(\/|$)/);
  });
}

for (const set of [1, 2, 3, 4, 5, 6]) {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORT_NAMES) {
      scenario(caseName(`auth: design preview /auth/${set}/login loads`, { theme, viewport }), { theme, viewport }, async ({ page }) => {
        await visit(page, `/auth/${set}/login`, { ready: "h1" });
        await page.locator('input[type="email"]').first().waitFor({ state: "visible" });
        await assertNoOverflow(page, `preview ${set}`);
      });
    }
  }
}
