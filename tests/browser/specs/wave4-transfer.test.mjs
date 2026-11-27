// Import and export on a collection page: CSV and JSON downloads, the import preview, the skip rule, the size limit,
// and unknown columns. Every file is built in memory, so no fixture is written into the repo.
import assert from "node:assert/strict";
import { completeOnboardingViaUi, signUpViaUi } from "../lib/accounts.mjs";
import { THEMES } from "../lib/config.mjs";
import { assertNoOverflow, caseName, scenario, visit, waitForSettled } from "../lib/session.mjs";
import { eventually } from "../lib/wait.mjs";
import { assertNoInfiniteAnimation, csvHeader, inMemoryFile, readDownload } from "../lib/wave4.mjs";

const NOTES = "/app/data/notes";
/** Three good rows and one whose required title is empty. The notes schema requires a title. */
const GOOD_AND_BAD_CSV = ["title,body", "Good one,First body", "Good two,Second body", "Good three,Third body", ",Missing its title"].join("\n") + "\n";
/** An unknown column. The import has to report it, not store it silently. */
const UNKNOWN_COLUMN_CSV = "title,body,bogus\nUnknown column row,Has an extra column,stored?\n";
const FOUR_MIB = 4 * 1024 * 1024;
const SIZE_MESSAGE = "That file is over 4 MB. Split it into smaller files.";

const sweeps = [
  { theme: "light", viewport: "desktop" },
  { theme: "dark", viewport: "desktop" },
  { theme: "light", viewport: "phone" },
  { theme: "dark", viewport: "phone" },
  { theme: "dark", viewport: "phone", reducedMotion: true },
];

async function signUpAndOnboard(page, name) {
  await signUpViaUi(page, { name });
  await completeOnboardingViaUi(page, { name });
}

async function openCollection(page) {
  await visit(page, NOTES, { ready: "h1" });
  await page.waitForFunction(() => !document.querySelector('[aria-label="Loading records"]'));
  await waitForSettled(page);
}

/** Opens the collection and its Import dialog. The dialog is a modal with its own title. */
async function openImport(page) {
  await openCollection(page);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import records", exact: true });
  await dialog.waitFor({ state: "visible" });
  return dialog;
}

for (const theme of THEMES) {
  scenario(caseName("transfer export: Export CSV and Export JSON download files, and the JSON parses", { theme }), { theme }, async ({ page }) => {
    await signUpAndOnboard(page, "Exporter");
    await openCollection(page);

    const csvButton = page.getByRole("button", { name: "Export CSV", exact: true });
    const jsonButton = page.getByRole("button", { name: "Export JSON", exact: true });
    await csvButton.waitFor({ state: "visible" });
    await jsonButton.waitFor({ state: "visible" });

    const [csvDownload] = await Promise.all([page.waitForEvent("download"), csvButton.click()]);
    const csv = await readDownload(csvDownload);
    assert.ok(csv.name.endsWith(".csv"), `the CSV is named .csv, got ${csv.name}`);
    // The export names its metadata columns __transfer.meta.* (backend/crates/transfer/src/export.rs), so a record
    // field called id or createdAt can't collide with them. The header then holds the schema fields and those three.
    const header = csvHeader(csv.text);
    for (const column of ["title", "__transfer.meta.id", "__transfer.meta.createdAt", "__transfer.meta.updatedAt"]) {
      assert.ok(header.includes(column), `the first line is a header with ${column}, got: ${header.join(",")}`);
    }

    const [jsonDownload] = await Promise.all([page.waitForEvent("download"), jsonButton.click()]);
    const json = await readDownload(jsonDownload);
    assert.ok(json.name.endsWith(".json"), `the JSON is named .json, got ${json.name}`);
    assert.doesNotThrow(() => JSON.parse(json.text), "the JSON download parses");
  });
}

for (const theme of THEMES) {
  scenario(caseName("transfer import: a preview of 3 good rows and 1 bad row, Import waits for the skip tick, then the counts", { theme }), { theme }, async ({ page }) => {
    await signUpAndOnboard(page, "Importer");
    const dialog = await openImport(page);

    await dialog.locator("#import-file").setInputFiles(inMemoryFile("notes.csv", "text/csv", GOOD_AND_BAD_CSV));
    await dialog.getByRole("button", { name: "Preview", exact: true }).click();

    // The preview counts the good rows and lists the bad one with its row number and field.
    await dialog.getByText("3 records ready to import.", { exact: true }).waitFor({ state: "visible" });
    const problems = dialog.getByRole("table");
    await problems.getByRole("cell", { name: "Title", exact: true }).waitFor({ state: "visible" });
    const rowNumbers = (await problems.locator("tbody tr td:first-child").allTextContents()).map((text) => text.trim());
    assert.ok(rowNumbers.some((text) => /^\d+$/.test(text)), `the problem table shows a row number, got: ${rowNumbers.join(", ")}`);

    // With all-or-nothing on, a problem row blocks Import.
    const importButton = dialog.getByRole("button", { name: "Import", exact: true });
    assert.equal(await importButton.isDisabled(), true, "Import is off while a row has a problem");

    // Turning all-or-nothing off clears the preview. Preview again, and the skip choice appears.
    await dialog.getByRole("checkbox", { name: /^Import all or nothing/ }).click();
    await dialog.getByRole("button", { name: "Preview", exact: true }).click();
    const skip = dialog.getByRole("checkbox", { name: /^Skip the 1 row with problems/ });
    await skip.waitFor({ state: "visible" });
    assert.equal(await importButton.isDisabled(), true, "Import stays off until the skip is ticked");

    await skip.click();
    await eventually(async () => !(await importButton.isDisabled()), { message: "Import should be on once the skip is ticked" });
    await importButton.click();

    await dialog.getByText("Imported 3 records.", { exact: true }).waitFor({ state: "visible" });
    await dialog.getByText("1 row skipped.", { exact: true }).waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByText("Good three", { exact: true }).first().waitFor({ state: "visible" });
    await assertNoOverflow(page, "collection after import");
  });
}

for (const theme of THEMES) {
  scenario(caseName("transfer import: a file over 4 MB is refused before anything is uploaded", { theme }), { theme }, async ({ page }) => {
    await signUpAndOnboard(page, "Big File");
    const dialog = await openImport(page);

    const uploads = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/import(\?|$)/.test(request.url())) uploads.push(request.url());
    });

    // One byte over the limit. The check is on size, so the contents do not matter.
    await dialog.locator("#import-file").setInputFiles(inMemoryFile("too-big.csv", "text/csv", Buffer.alloc(FOUR_MIB + 1, "a")));

    const error = dialog.locator("#import-file-error");
    await error.waitFor({ state: "visible" });
    assert.equal((await error.innerText()).trim(), SIZE_MESSAGE);
    assert.equal(await dialog.locator("#import-file").getAttribute("aria-invalid"), "true", "the file input is marked invalid");
    assert.equal(await dialog.getByRole("button", { name: "Preview", exact: true }).isDisabled(), true, "nothing can be previewed");
    assert.deepEqual(uploads, [], "no import request was sent for the oversized file");
  });
}

for (const theme of THEMES) {
  scenario(caseName("transfer import: an unknown column is a row error, and nothing is stored", { theme }), { theme }, async ({ page }) => {
    await signUpAndOnboard(page, "Unknown Column");
    const dialog = await openImport(page);

    await dialog.locator("#import-file").setInputFiles(inMemoryFile("extra.csv", "text/csv", UNKNOWN_COLUMN_CSV));
    await dialog.getByRole("button", { name: "Preview", exact: true }).click();

    // The unknown column is named in the problem table, under its own name as the file wrote it.
    const problems = dialog.getByRole("table");
    await problems.getByRole("cell", { name: "bogus", exact: true }).waitFor({ state: "visible" });
    await dialog.getByText("None of the rows can be imported yet.", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await dialog.getByRole("button", { name: "Import", exact: true }).isDisabled(), true, "Import is off");

    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(await page.getByText("Unknown column row", { exact: true }).count(), 0, "the row was not stored");
  });
}

// The phone layout of the collection and its Import dialog, then the single reduced-motion sweep.
for (const sweep of sweeps) {
  scenario(
    caseName("transfer: the collection and its Import dialog load cleanly, with no overflow", sweep),
    sweep,
    async ({ page, guard }) => {
      await signUpAndOnboard(page, "Sweeper");
      await openCollection(page);
      await assertNoOverflow(page, "collection");
      if (sweep.reducedMotion) await assertNoInfiniteAnimation(page, "collection");
      await guard.check("collection");

      await page.getByRole("button", { name: "Import", exact: true }).click();
      await page.getByRole("dialog", { name: "Import records", exact: true }).waitFor({ state: "visible" });
      await assertNoOverflow(page, "import dialog");
      if (sweep.reducedMotion) await assertNoInfiniteAnimation(page, "import dialog");
      await guard.check("import dialog");
    },
  );
}
