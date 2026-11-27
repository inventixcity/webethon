# CX2: Global UI fixes (header layout, nav bars, sidebar, contrast, mobile images). Web only.
You fix the cross-cutting findings from the user's examiner review. Screenshots are in handoff/review/examiner/page1.png..page4.png; open them, page 1 matters most. Rules: handoff/HANDOFF.md "USER UI RULES" (shared square Button with fill-wipe hover, no wiggle, no tickers, dark mode = black shades only, tokens only).

You own:
- web/src/components/app-shell/**
- web/src/components/ui/tabs.tsx, badge.tsx and any shared tab, filter or nav-bar component
- web/src/components/exams/exam-tabs.tsx
- web/src/app/globals.css (contrast tokens only)
- web/src/app/(app)/app/layout.tsx
- the page-header LAYOUT (coordinate: CX1 owns the banner `<Art>` line in web/src/components/ui/page-header.tsx; you may restructure the rest of that file's layout, but keep the `position="object-right"` CX1 adds)

Do NOT edit auth, landing, the exam workspace, admin pages, or question/candidate/review screens (CX1, CX3 and CX4 own those).

Fix:
1. **Page header layout (item 2).** On Overview and every page using PageHeader, there is a lot of empty space under the description; the action buttons float in the middle; the figure sits jammed at the far side and isn't vertically centred. Redesign PageHeader as a tight, balanced band:
   - eyebrow, title and description on the left
   - actions directly under the description (left-aligned, a consistent gap)
   - the figure on the right, vertically centred with the text block and sized proportionally (about 240–300px wide)
   - no dead space
   - the animated accent hairline below
   - on mobile, stacked: text, actions, figure full width
   Check Overview, Exams, Question bank, the exam detail header, Users, Audit and System.
2. **The "HOLD: ALL DEVICES" sidebar button (item 3) looks broken.** Redesign it as a proper secondary action: "Sign out of all devices" in the shared Button style with a clear hold-to-confirm progress fill (keep press-and-hold for safety, show "Hold to confirm" helper text, and give it a keyboard alternative), matching the Sign out button above it.
3. **Nav and tab bars (item 4):** the filter row (ALL / DRAFT / PUBLISHED / COMPLETED / ARCHIVED), the exam tabs and every similar navigation bar must be more readable and prominent:
   - larger mono labels (12–13px), clear contrast
   - the active state as a filled or underlined tab with a cobalt indicator
   - hover states and counts where available
   - visible focus
   - consistent everywhere
4. **Sidebar role badge overlaps nav links (admin review items 6/7).** Move the role badge into the logo row (`flex h-16 items-center justify-between`), so it can never collide with the scrolling nav.
5. **Contrast in both themes (item 5).** Every button, label, chip and muted text must be readable in light AND dark: grey on white and grey on black are both failing today. Audit the tokens (ink-muted, rule, disabled and outline variants) and fix them to ≥ 4.5:1 for text and ≥ 3:1 for boundaries.
6. **Images don't show on mobile (item 1).** The PageHeader figure and others are hidden or collapsed on small screens. Show them on mobile, full width with a fixed aspect ratio, below the text.
Verify with the screenshot tools in C:/Users/umerf/AppData/Local/Temp/claude/46368f72d808e358/3d64d5b3-0eee-4935-9e2c-1276c595d01d/scratchpad: shots.mjs and shots-theme.mjs (THEME=light|dark, W, H; sessions cached for examiner@invigil.app, admin@invigil.app and candidate@invigil.app). Shoot /app/examiner, /app/examiner/exams, /app/examiner/questions, /admin and /app/candidate at 1440 and 390, in both themes. Read the PNGs and iterate. `cd web && pnpm typecheck` must be clean. Write handoff/log/CX2.md, ending with `STATUS: COMPLETE`.
