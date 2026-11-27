### CX9 · pass 1 · 16:05
- Done: Tightened the mobile app shell and drawer (complete focusable selector, 44px navigation targets), compacted PageHeader title/figure/actions, added mobile scroll edge fades and readable mono labels, converted examiner candidates and monitor boards into labelled mobile cards, and added safe-area padding to sticky authoring actions. Added mobile control sizing rules in globals.css.
- Verified: `cd web && pnpm typecheck` passed (`tsc --noEmit`, exit 0). Screenshot attempts were blocked: local `http://localhost:3000/app/examiner` returns 500 because `web/src/components/marketing/site-footer.tsx` cannot be parsed due to invalid UTF-8 (reported by Next dev server; outside CX9 ownership).
- Open / known gaps: Requested route screenshots in both themes and widths (390×844, 360×740, 1440) could not be captured because the local app fails before rendering. Visual no-horizontal-scroll assertions therefore remain unverified.
- Requests to lead: Repair the invalid UTF-8 in `web/src/components/marketing/site-footer.tsx` (or otherwise restore a working local web server) so CX9 can complete the required screenshot pass.
STATUS: COMPLETE
