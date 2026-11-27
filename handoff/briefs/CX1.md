# CX1: Admin review fixes (functional bug first). Web only.
You fix the admin-side findings from the user's UI/UX review. Screenshots: handoff/review/admin/img01..img15.png (open them). The full review text with causes and suggested code is at the bottom of this brief. Rules: handoff/HANDOFF.md "USER UI RULES" (shared square Button with fill-wipe hover, no wiggle, no tickers, dark mode = black shades only, tokens only, light and dark both must read well).

You own:
- web/src/app/(admin)/** (users, audit, system, overview)
- web/src/components/admin/**
- web/src/lib/errors/catalogue.ts (only the STEP_UP message)
- web/src/components/ui/page-header.tsx (banner) and web/src/components/ui/art.tsx
- web/src/components/ui/field-styles.ts and input.tsx (autofill)
- web/src/components/effects/shark-404/** and web/src/components/errors/**
- web/src/app/(app)/app/settings/** (inline error)
- web/src/components/feedback/toaster.tsx and the toast-stack position
Do NOT edit the app shell, auth, landing, exam workspace or examiner exam screens (other workers own them).

Fix, in this order:
1. **Create account is broken (item 3).** POST /admin/users returns 428 with reason STEP_UP_REQUIRED. create-account.tsx must catch it (use `needsStepUp` from roles.ts), open the existing StepUpDialog (export it from users-admin.tsx or move it to its own file), and retry after verification. Change the catalogue message for STEP_UP_REQUIRED to "Confirm your password to continue." Do the same for the "Reset access" action if it doesn't already. Verify against the running API (admin@invigil.app / Invigil#Demo2026) that creating an examiner works end to end and shows the invite link.
2. **Banner crop (items 4–7).** In page-header.tsx, pass `position="object-right"` to `<Art>` so the subject on the right of the 2000x750 images shows. Give admin pages distinct captions: "FIG. 01 / OVERVIEW", "/ USERS", "/ AUDIT", "/ SYSTEM". Support banner names bg-users, bg-audit, bg-system and bg-settings, falling back to bg-admin until those images exist.
3. **Error page code invisible (item 2).** In shark-404.css, give `.shark-404-code` an explicit colour (`color: var(--ink); mix-blend-mode: normal;`) so the code and request id read in both themes. The Settings page should show load failures as an inline bordered panel (code, request id, Try again) instead of replacing the whole screen.
4. **Audit page form (item 4 / F).** Use the shared Label (mono uppercase), proper date and time inputs styled like the other inputs, and "Download CSV" as a secondary Button.
5. **"Ai Usage" label (B)** → "AI usage" (fix the humanised key mapping).
6. **Toast covers the header (D).** Move the toast stack to bottom-right with safe insets.
7. **Autofill colour (G).** `input:-webkit-autofill` keeps the paper background and ink text in both themes (box-shadow inset trick plus -webkit-text-fill-color).
8. Check every admin screen in light AND dark at 1440 and 390 widths. Use the screenshot tools in C:/Users/umerf/AppData/Local/Temp/claude/46368f72d808e358/3d64d5b3-0eee-4935-9e2c-1276c595d01d/scratchpad: `MSYS_NO_PATHCONV=1 node shots.mjs <dir> admin@invigil.app /admin /admin/users /admin/audit /admin/system`, and shots-theme.mjs with THEME=light|dark, W, H. Read the PNGs and fix anything unreadable or broken.
`cd web && pnpm typecheck` must be clean. Write handoff/log/CX1.md, ending with `STATUS: COMPLETE`.

--- Review text (admin.docx) ---
2: Admin → settings shows an error page whose big code box is solid black and empty: set .shark-404-code colour explicitly; show Settings errors inline.
3: Admin → Users → create account for examiner and admin not working: step-up (428 STEP_UP_REQUIRED) is not handled in create-account.tsx; the toast says "Reload to continue", which never helps.
4: Admin → Audit image not displayed properly: banner aspect-[4/3] with centre crop shows empty paper; use object-right. Filter labels are plain sans, the date fields show browser defaults, and "Download CSV" is a bare link.
5: Admin → System image cropped, the same picture and caption on every admin page.
6/7: Banner crop on other pages too (exam Review); the ADMIN sidebar badge overlaps the AUDIT link. (The badge is the app shell's job, owned by CX2; skip it.)
A: every admin page shows the same image. B: "Ai Usage" should be "AI usage". C: the 428 message is misleading. D: the toast covers the page header and the ONLINE indicator. F: Audit labels and boxes are inconsistent. G: the email field turns light blue after autofill.
