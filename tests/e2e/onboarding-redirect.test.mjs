import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '../browser/node_modules/playwright-core/index.mjs';
import { messageIds, waitForCode } from './lib/mail.mjs';
import { email, password } from './lib/fixtures.mjs';

const web = (process.env.WEB_URL || 'http://localhost:3000').replace(/\/$/, '');
const edge = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

test('onboarding is enforced after verification and sign in', { timeout: 120_000 }, async () => {
  const browser = await chromium.launch({ executablePath: edge, headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const address = email();
  try {
    const before = await messageIds(address);
    await page.goto(`${web}/signup`);
    await page.getByLabel('Full name').fill('Onboarding Test');
    await page.getByLabel('Email', { exact: true }).fill(address);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByLabel('I accept the terms and the privacy policy.').check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForURL(/\/verify/);
    await page.getByLabel('Verification code').fill(await waitForCode(address, before));
    await page.waitForURL(/\/app\/onboarding\/?$/);

    await page.goto(`${web}/app/settings`);
    assert.equal(new URL(page.url()).pathname, '/app/settings');
    const dashboardLink = page.locator('a[href="/app"]').first();
    await dashboardLink.click();
    await page.waitForURL(/\/app\/onboarding\/?$/);
    await page.goto(`${web}/app/onboarding`);
    assert.equal(new URL(page.url()).pathname, '/app/onboarding');
    await context.setExtraHTTPHeaders({ 'x-app-pathname': '/app/settings' });
    await page.goto(`${web}/app`);
    await page.waitForURL(/\/app\/onboarding\/?$/);
    await context.setExtraHTTPHeaders({});

    const second = await browser.newContext();
    const login = await second.newPage();
    await login.goto(`${web}/login`);
    await login.getByLabel('Email', { exact: true }).fill(address);
    await login.getByLabel('Password', { exact: true }).fill(password);
    await login.getByRole('button', { name: 'Sign in' }).click();
    await login.waitForURL(/\/app\/onboarding\/?$/);
    const saved = await second.request.put(`${web}/api/v1/onboarding`, { data: { answers: {}, completed: true } });
    assert.equal(saved.status(), 200);
    await login.goto(`${web}/app`);
    assert.equal(new URL(login.url()).pathname, '/app');
    await login.goto(`${web}/app/data`);
    assert.equal(new URL(login.url()).pathname, '/app/data');
    await second.close();
  } finally {
    await browser.close();
  }
});
