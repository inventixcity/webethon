# CX5: Monitor (control room) and Grading screens: colourful, clear, bold. Web only.
User feedback (screenshots in handoff/review/examiner2/page2.png): "this nav bar and the UI of this screen need to be a little colourful, clear and bold" (the exam Monitor page), plus the Grading page. Rules: handoff/HANDOFF.md "USER UI RULES" (the shared square Button with fill-wipe hover, no wiggle, no tickers, dark mode = black shades only, tokens only: ink/paper plus the cobalt (live, info), amber (caution) and vermilion (focal and errors) accents; readable in light and dark).

You own: web/src/components/monitor/**, web/src/components/grading/** and the pages `web/src/app/(app)/app/examiner/exams/[examId]/{monitor,grading}/**`. Don't edit the app shell, exam-tabs.tsx (CX2 is improving the tab bar globally), page-header, admin, auth or workspace.

Make the Monitor a bold, readable control room:
1. **KPI counters** (Enrolled, Not started, In progress, Submitted) as strong tiles. Each has a coloured top rule and a tone (cobalt in progress with a live pulse, amber not started, ink submitted), big numerals, and a small trend or percent of enrolled.
2. **Toolbar.** The "LIVE / Polling" badge, "Updated Ns ago", Refresh and "Credit an outage" form a clear toolbar row with proper Buttons. Filters (Offline only, High priority only) are toggle chips, not tiny checkboxes, and Sort is a styled select.
3. **Candidate board.** A clear table with a header row.
   - Each row has: name, a status chip with colour plus a word, a progress bar answered/total, time left, a connection dot with label, an incident count chip (amber when > 0) and a review priority chip.
   - Readable 13–14px text, zebra or hairline rows, and a clickable row with a hover tint opening the integrity side panel.
   - The empty state when nobody has started.
4. **Announcements panel.** Clear heading, textarea, char count, and a primary "Send announcement" Button. Recent announcements are listed with times.
5. **Grading page.**
   - Clear progress ("12 of 40 graded" with a meter).
   - The per-question filter as chips.
   - Script cards with clear sections (question, rubric, answer, marks).
   - The AI "Suggest a mark" as a visible secondary Button with a sparkle-free plain label.
   - The suggestion card in a cobalt-ruled panel.
   - The error state: if the API errors, show the request id and a retry Button inline (not a bare red box).
Test against the running API at http://localhost:3000 (the examiner cookie is cached in C:/Users/umerf/AppData/Local/Temp/claude/46368f72d808e358/3d64d5b3-0eee-4935-9e2c-1276c595d01d/scratchpad/.session-examiner_invigil_app.json; if it's expired, sign in through the API as examiner@invigil.app / Invigil#Demo2026 and update that file). Use shots.mjs and shots-theme.mjs (THEME=light|dark, W, H) on /app/examiner/exams/<id>/monitor and /grading for "Data Structures Midterm" and "Databases Final", at 1440 and 390, in both themes. Read the PNGs and iterate until it's clearly better. `cd web && pnpm typecheck` must be clean. Write handoff/log/CX5.md, ending with `STATUS: COMPLETE`.
