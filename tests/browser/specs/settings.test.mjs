// Settings: change the display name, and turn two-step sign-in on, sign in with a code, then turn it off again.
import assert from "node:assert/strict";
import { completeOnboardingViaUi, enterCode, signInViaUi, signOutViaUi, signUpViaUi, waitForPath } from "../lib/accounts.mjs";
import { PASSWORD, THEMES } from "../lib/config.mjs";
import { assertNoOverflow, caseName, scenario, visit, waitForSettled } from "../lib/session.mjs";
import { base32Decode, hotp, timeStep, totp, waitForStepAfter } from "../lib/totp.mjs";

const SETTINGS = "/app/settings";

for (const theme of THEMES) {
  scenario(caseName("settings: change the display name, and the new name shows on the home page", { theme }), { theme }, async ({ page }) => {
    await signUpViaUi(page, { name: "Old Name" });
    await completeOnboardingViaUi(page, { name: "Old Name" });
    await visit(page, SETTINGS, { ready: "h1" });
    await waitForSettled(page);

    const name = `Renamed ${Date.now().toString(36)}`;
    await page.getByLabel("Display name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Save profile", exact: true }).click();

    // The value has to survive a reload, which proves it reached the API and not just local state.
    await visit(page, SETTINGS, { ready: "h1" });
    await waitForSettled(page);
    assert.equal(await page.getByLabel("Display name", { exact: true }).inputValue(), name);

    await visit(page, "/app", { ready: "h1" });
    await page.getByRole("heading", { name: `Welcome back, ${name}.` }).waitFor({ state: "visible" });
    await assertNoOverflow(page, "home page after rename");
  });
}

for (const theme of THEMES) {
  scenario(caseName("settings: two-step sign-in on, sign in with a code, then off", { theme }), { theme }, async ({ page }) => {
    const account = await signUpViaUi(page, { name: "Two Step" });
    await completeOnboardingViaUi(page, { name: "Two Step" });
    await visit(page, SETTINGS, { ready: "h1" });
    await waitForSettled(page);

    // Starting the set-up returns the shared secret. It is read from the response, not scraped from the QR code.
    await page.getByRole("button", { name: "Enable two-step verification", exact: true }).click();
    // The password-change form on the same page also has a "Current password" field, so scope to this form.
    const setupForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Continue", exact: true }) });
    await setupForm.getByLabel("Current password", { exact: true }).fill(PASSWORD);
    const [setupResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/v1/auth/mfa/totp/setup") && response.request().method() === "POST"),
      setupForm.getByRole("button", { name: "Continue", exact: true }).click(),
    ]);
    const setup = await setupResponse.json();
    const secret = setup.data.secret;
    assert.ok(secret, "the setup response should include the secret");

    const verifyForm = page.locator("form").filter({ has: page.getByLabel("Authenticator code", { exact: true }) });
    await verifyForm.getByLabel("Authenticator code", { exact: true }).fill(totp(secret));
    const enabledAtStep = timeStep();
    await verifyForm.getByRole("button", { name: "Enable", exact: true }).click();
    await page.getByRole("button", { name: "I saved them", exact: true }).waitFor({ state: "visible" });
    await assertNoOverflow(page, "two-step recovery codes");
    await page.getByRole("button", { name: "I saved them", exact: true }).click();

    // Servers refuse a code that was already used, so the sign-in code has to come from a later time step.
    await signOutViaUi(page);
    await signInViaUi(page, account);
    await waitForPath(page, /^\/verify$/);
    const signInStep = await waitForStepAfter(enabledAtStep);
    await enterCode(page, hotp(base32Decode(secret), signInStep));
    await waitForPath(page, /^\/app(\/|$)/);

    // Turn it off again. The disable form is its own form, with its own password and code fields. Its code must
    // come from a step after the sign-in code, for the same replay reason.
    const disableStep = await waitForStepAfter(signInStep);
    await visit(page, SETTINGS, { ready: "h1" });
    await waitForSettled(page);
    await page.getByRole("button", { name: "Turn off", exact: true }).click();
    const disableForm = page.locator("form").filter({ has: page.getByLabel("Authenticator or recovery code", { exact: true }) });
    await disableForm.getByLabel("Current password", { exact: true }).fill(PASSWORD);
    await disableForm.getByLabel("Authenticator or recovery code", { exact: true }).fill(hotp(base32Decode(secret), disableStep));
    await disableForm.getByRole("button", { name: "Turn off", exact: true }).click();
    // Back to the "off" state: the enable button returns and the disable form is gone.
    await page.getByRole("button", { name: "Enable two-step verification", exact: true }).waitFor({ state: "visible" });
    await disableForm.waitFor({ state: "detached" });
  });
}
