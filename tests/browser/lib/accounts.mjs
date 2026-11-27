import { PASSWORD, WEB_URL, uniqueEmail } from "./config.mjs";
import { messageIds, waitForCode } from "./mail.mjs";
import { visit, waitForHydration } from "./session.mjs";

/** Waits until the URL's pathname matches, which is how the app signals a finished page change. */
export function waitForPath(page, pattern, timeout = 90_000) {
  return page.waitForURL((url) => pattern.test(url.pathname), { timeout });
}

/** Types the six-digit code. The OTP input submits itself once all six digits are in. */
export async function enterCode(page, code) {
  const input = page.getByLabel("Verification code");
  await input.waitFor({ state: "visible" });
  await waitForHydration(page, 'input[aria-label="Verification code"]');
  await input.fill(code);
}

/**
 * Creates a brand-new account through the real sign-up form, reads the emailed code and verifies it.
 * A new account has not finished onboarding, so it lands under /app/onboarding rather than /app.
 * Returns the credentials so the test can sign in again later.
 */
export async function signUpViaUi(page, { name = "Browser Test", email = uniqueEmail(), password = PASSWORD } = {}) {
  const before = await messageIds(email);
  await visit(page, "/signup", { ready: "form" });
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("I accept the terms and the privacy policy.").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await waitForPath(page, /^\/verify$/);

  const code = await waitForCode(email, before);
  await enterCode(page, code);
  await waitForPath(page, /^\/app(\/|$)/);
  return { name, email, password };
}

/**
 * Walks the real onboarding flow: welcome, name, one interest, one notification choice, then "Finish setup".
 * Until it is finished, the app redirects every /app page except settings to /app/onboarding.
 */
export async function completeOnboardingViaUi(page, { name = "Browser Test" } = {}) {
  await visit(page, "/app/onboarding", { ready: "h1" });
  const next = () => page.getByRole("button", { name: "Next", exact: true });
  await next().click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await next().click();
  await page.getByRole("button", { name: "Music", exact: true }).click();
  await next().click();
  // The radio is visually hidden behind its label, so the label is what the visitor clicks.
  await page.locator("label").filter({ hasText: "Important only" }).click();
  await next().click();
  await page.getByRole("button", { name: "Finish setup", exact: true }).click();
  await waitForPath(page, /^\/app(?!\/onboarding)(\/|$)/);
}

/** Signs in through the login form. Resolves once the browser has left the form for its destination. */
export async function signInViaUi(page, { email, password }, { next } = {}) {
  await visit(page, `/login${next ? `?next=${encodeURIComponent(next)}` : ""}`, { ready: "form" });
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/**
 * Signs out through the settings page. Settings is exempt from the onboarding redirect, so this works for an
 * account that has not finished onboarding (the app home page would redirect it away). "Sign out of every device"
 * is the sign-out control available there; it ends the session and clears the cookie. Ends on /login.
 */
export async function signOutViaUi(page) {
  await visit(page, "/app/settings", { ready: "h1" });
  await page.getByRole("button", { name: "Sign out of every device", exact: true }).click();
  await waitForPath(page, /^\/login$/);
}

/**
 * Signs in as the demo account through the API. Uses the context's request client, so the session cookie lands
 * in that browser context without going through the form. Returns the user object.
 */
export async function demoSignIn(context) {
  const response = await context.request.post(`${WEB_URL}/api/v1/auth/demo`);
  if (!response.ok()) throw new Error(`Demo sign-in returned ${response.status()}: ${await response.text()}`);
  const body = await response.json();
  return body.data.user;
}
