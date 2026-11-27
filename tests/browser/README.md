# Browser tests

End-to-end tests that drive the real web app in Microsoft Edge, through the UI, the same way a visitor would. They
use `playwright-core` (pinned in `package.json`) and Node's built-in test runner. There is no `@playwright/test`
and no browser download: the tests launch the Edge that is already installed (`channel: "msedge"`).

The API black-box tests live in `tests/e2e` and are separate; this suite only goes through the browser.

## What is covered

| File | Covers |
| --- | --- |
| `specs/auth.test.mjs` | Sign-up with the emailed code, wrong password, sign-out and redirect, forgot password to new password, the six design previews `/auth/1..6/login` |
| `specs/app-pages.test.mjs` | Every signed-in page: status 200, no console or page errors, no unexpected 5xx, no horizontal overflow |
| `specs/data.test.mjs` | Create, edit and delete a note; a note created in one tab appears in a second tab without reloading |
| `specs/files.test.mjs` | Upload a generated PNG, see it, delete it (checked through the API as well) |
| `specs/settings.test.mjs` | Change the display name; turn on two-step sign-in, sign in with a TOTP code, turn it off |
| `specs/teams.test.mjs` | Create a team, invite a second user, accept the invitation in the second user's browser |
| `specs/booking.test.mjs` | Create a resource with weekly hours, book a slot (it disappears), cancel the booking |
| `specs/places.test.mjs` | The map canvas draws something (non-blank pixels); a new place appears in the list |
| `specs/kit.test.mjs` | `/kit` and every `/kit/effects/*` page, in both themes (effect links are read from `/kit`) |
| `specs/wave4-admin.test.mjs` | Admin jobs and flags: a normal user gets the 404 page; the jobs status filter and pager; flag key, JSON and email field errors; step-up on save; delete asks for confirm. Needs `ADMIN_EMAIL` and `ADMIN_PASSWORD`, otherwise skipped |
| `specs/wave4-sharing.test.mjs` | Webhooks in settings (secret shown once, invalid address error on its field, send test, deliveries, delete confirm); share links (empty state, revoke confirm); the Share dialog on a note; the public `/s/` page and the gone page, with noindex |
| `specs/wave4-transfer.test.mjs` | Export CSV and JSON downloads; import preview with a bad row, the skip rule and the counts; a file over 4 MB refused before upload; an unknown column reported as a row error |
| `specs/wave4-flags-public.test.mjs` | `GET /flags` read once on load and not again on in-app navigation. The visible-flag check is skipped until a component calls `useFlag` |
| `unit/helpers.test.mjs` | The suite's own helpers: TOTP against the RFC 6238 vectors, PNG round-trip, code extraction |

Every browser test runs in a fresh browser context with a fresh account, and runs in both themes. Layouts that
change on a phone are also run at 390x844. One sweep runs with reduced motion.

## Running it

Requirements: Node 22 or newer (Node 24 is what the suite was written on), Microsoft Edge installed, and the app
running. Install once:

```sh
cd tests/browser
npm install
```

### Against local development

Start the stack as `docs/BACKEND.md` describes: `make dev-db`, `make api`, then `make web` (web on
`http://localhost:3000`, Mailpit on `http://localhost:8025`). Then:

```sh
npm test                    # every spec and the unit tests, through node --test
node run.mjs                # the same, printed as a pass/fail table (also writes artifacts/results.json)
node run.mjs auth kit       # only the spec files whose name contains "auth" or "kit"
node run.mjs --name "dark"  # only tests whose title contains "dark"
```

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEB_URL` | `http://localhost:3000` | Origin of the web app. The app proxies `/api/v1` itself, so no separate API URL is needed. |
| `MAILPIT_URL` | `http://localhost:8025` | Mailpit, which receives every email the API sends. Codes and invitation links are read from it. |
| `RATE_LIMIT_RESET_CMD` | unset | Shell command run before each test to clear the API's rate-limit counters. See below. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | unset | An account listed in the API's `ADMIN_EMAILS`, for `wave4-admin`. Same variables as `tests/e2e`. Those specs skip with a reason when either is unset. |

#### Rate limits on a local stack

The API limits sign-ups to 6 per IP per hour, and sign-ins to 20 per IP per 15 minutes. A browser run is one IP
(loopback), so a full run creates far more accounts than that budget allows. Two ways through:

- **Local development (recommended):** set `RATE_LIMIT_RESET_CMD` to the reset script. It truncates the
  `rate_limits` table in the local Postgres container. That table only holds counters; no accounts or records
  are touched. Run this only against a disposable local database.

  ```sh
  # bash
  export RATE_LIMIT_RESET_CMD='node scripts/reset-rate-limits.mjs'
  ```

  ```powershell
  # PowerShell
  $env:RATE_LIMIT_RESET_CMD = 'node scripts/reset-rate-limits.mjs'
  ```

  The script waits for Postgres to accept connections and can be pointed elsewhere with
  `RATE_LIMIT_CONTAINER`, `RATE_LIMIT_DB` and `RATE_LIMIT_DB_USER`. Other tools on the same stack share these
  counters, so do not reset while another load test is running against it.

- **Shared or production-like environments:** leave it unset. Then the suite will hit the real limits and fail
  with `RATE_LIMITED` once the budget is spent. That is the correct behaviour for those environments; use a
  disposable environment for a full run.

### Against the kind cluster

`scripts/k8s-up.sh` brings the cluster up with ingress-nginx in front of the API. Expose the web app and Mailpit
locally (port-forward, or the ingress host), then point the suite at them:

```sh
WEB_URL=https://<web-ingress-host> MAILPIT_URL=http://localhost:8025 npm test
```

The cluster's API sits behind ingress, and its own rate limits apply to the ingress's client IP. Expect the same
budget limits as above, so set `RATE_LIMIT_RESET_CMD` only if that reset is safe for the cluster's database.

### Against a Vercel preview

Use the preview's URL. A preview is production-like: `RATE_LIMIT_RESET_CMD` must be unset, and the preview's
API must have a Mailpit or another inbox the suite can read. If the preview's email goes to a real provider, the
suite cannot read the codes, so run it only where email lands in an inbox the suite can reach.

```sh
WEB_URL=https://<your-preview>.vercel.app MAILPIT_URL=https://<inbox> npm test
```

Vercel deployment protection can answer with a login page. If so, use an access route the protection allows
(for example a protection bypass), not a change to the suite.

## Output

`node run.mjs` prints one row per test (`PASS`, `FAIL` or `SKIP`) with the reason for each failure, then writes
`artifacts/results.json`. A failing browser test also saves a full-page screenshot and the page URL in
`artifacts/`. The `artifacts/` folder and `node_modules/` are gitignored.

## Writing tests

- Use the labels and roles the UI exposes. Do not select by CSS classes that come from the design.
- Wait on a condition: `visit()` (navigation and hydration), `waitForPath()`, `waitForSettled()`, `eventually()`,
  or a locator's `waitFor()`. No fixed sleeps. The only timing wait is the TOTP step, and it waits on the clock.
- `scenario()` gives each test a fresh context, clears rate limits first (when configured), and fails on any
  uncaught exception, any console error, or any unexpected 5xx. Two things are not counted as errors: a console
  line for a 4xx from `/api/v1/` (the app rejecting a wrong password or a signed-out call is correct behaviour, and
  the browser logs it as a failed resource), and the 503 `NOT_CONFIGURED` from the AI and billing routes, listed in
  `lib/config.mjs`. Other failing requests, such as a missing asset, still fail the test.
- A failure in the suite that comes from the app is reported as the app's problem. Do not work around it in a test.
