// Teams: create a team, invite a second user, and accept the invitation from that user's own browser.
import assert from "node:assert/strict";
import { completeOnboardingViaUi, signUpViaUi, waitForPath } from "../lib/accounts.mjs";
import { THEMES } from "../lib/config.mjs";
import { messageIds, waitForMatch } from "../lib/mail.mjs";
import { assertNoOverflow, caseName, openPage, scenario, visit, waitForSettled } from "../lib/session.mjs";

const INVITE_LINK = /https?:\/\/[^\s"'<>]+\/app\/teams\/join\?token=[A-Za-z0-9_-]+/;

for (const theme of THEMES) {
  scenario(caseName("teams: create a team, invite a second user, accept from their browser", { theme }), { theme }, async ({ page }) => {
    const owner = await signUpViaUi(page, { name: "Team Owner" });
    await completeOnboardingViaUi(page, { name: "Team Owner" });

    // The invitee has their own browser context, so their session is separate from the owner's.
    const invitee = await openPage({ theme });
    try {
      const invitedAccount = await signUpViaUi(invitee.page, { name: "Team Invitee" });
      await completeOnboardingViaUi(invitee.page, { name: "Team Invitee" });

      const teamName = `Night Owls ${Date.now().toString(36)}`;
      await visit(page, "/app/teams", { ready: "h1" });
      await page.getByLabel("Team name", { exact: true }).fill(teamName);
      await page.getByRole("button", { name: "Create team", exact: true }).click();
      await waitForPath(page, /^\/app\/teams\/[^/]+$/);
      await waitForSettled(page);
      await assertNoOverflow(page, "team page");

      const before = await messageIds(invitedAccount.email);
      await page.getByLabel("Email to invite", { exact: true }).fill(invitedAccount.email);
      await page.getByRole("button", { name: "Send invite", exact: true }).click();
      await page.getByText(`Invite sent to ${invitedAccount.email}`).waitFor({ state: "visible" });

      const link = await waitForMatch(invitedAccount.email, INVITE_LINK, before);
      await visit(invitee.page, new URL(link).pathname + new URL(link).search, { ready: "h1" });
      await invitee.page.getByText(/You joined/).waitFor({ state: "visible" });
      await assertNoOverflow(invitee.page, "invitation page");
      await invitee.guard.check("invitee browser");

      // The owner's view now lists the invitee as a member.
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForSettled(page);
      const members = page.getByRole("list", { name: "Members", exact: true });
      await members.getByText(invitedAccount.name, { exact: false }).first().waitFor({ state: "visible" });
      assert.notEqual(owner.email, invitedAccount.email);
    } finally {
      await invitee.close();
    }
  });
}
