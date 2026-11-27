### CX1 · pass 1 · 14:56
- Done: Create account now detects 428 step-up requirements, opens the shared identity dialog and retries with preserved form details. Reset access already uses the same verification and retry pattern. Updated the precondition message, admin banner crops/captions with per-page image fallback, Audit filters and CSV button, AI usage label, inline Settings load error panel, Shark 404 code contrast, toast safe-area placement and autofill colours.
- Verified: `cd web && pnpm typecheck` — passed (`tsc --noEmit`, exit 0). Ran the supplied `shots-theme.mjs` for `/admin`, `/admin/users`, `/admin/audit`, `/admin/system` at THEME=light,dark and W=1440,390 — all screenshots captured and reviewed. Local admin browser flow passed: 428 opened step-up, password verification succeeded, retry created an examiner and the invite link appeared. Existing Reset access handler was checked: it already retries after step-up verification.
- Open / known gaps: `bg-users`, `bg-audit`, and `bg-system` assets are not present, so each page currently falls back to `bg-admin` with the requested distinct caption. Local verification created one `example.test` examiner account.
- Requests to lead: None.
STATUS: COMPLETE
### CX1 · pass 2 · 14:57
- Done: Moved the shared step-up dialog into `web/src/app/(admin)/admin/users/step-up-dialog.tsx` so Create account and Reset access use it without a module cycle.
- Verified: `cd web && pnpm typecheck` — passed (`tsc --noEmit`, exit 0).
- Open / known gaps: See pass 1.
- Requests to lead: None.
STATUS: COMPLETE
