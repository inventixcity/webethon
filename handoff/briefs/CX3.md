# CX3: Examiner screens fixes (question bank, Questions tab, Candidates tab, Review tab). Web only.
You fix the examiner-screen findings from the user's review. Screenshots: handoff/review/examiner/page2.png, page3.png and page4.png (open them). Rules: handoff/HANDOFF.md "USER UI RULES" (shared square Button with fill-wipe hover, no wiggle, no tickers, dark mode = black shades only, tokens only, readable in light and dark).

You own:
- web/src/components/questions/** and web/src/app/(app)/app/examiner/questions/**
- web/src/app/(app)/app/examiner/exams/[examId]/(setup)/** (questions, candidates, review)
- web/src/components/exams/** EXCEPT exam-tabs.tsx and the examiner overview dashboard
- web/src/components/import/**
Do NOT edit the app shell, page-header, admin pages, auth, landing or the exam workspace.

Fix:
1. **Question bank, empty results (item 6).** When the filters match nothing, the left shows an illustration, but the right "preview" pane shows only "Select a question to preview it". Give the preview pane a designed empty state too: an `<Art name="empty-questions">` or an ASCII and illustrative panel, a short line, and a "Clear filters" Button. In general the preview pane needs a designed idle state.
2. **Question bank Edit and Delete (item 12)** are plain red and white text. Make them proper actions: an icon-plus-label secondary Button for Edit and a danger-outline Button for Delete (both with the fill-wipe hover), aligned in a right-hand action column, with the Delete confirmation kept.
3. **Exam Questions tab (item 8):** "errors in UI, and the flow of how data loads is unclear; what is the purpose of each part?"
   - Make the two panes self-explanatory: a numbered heading and a one-line purpose ("01 / Question bank: pick questions to add"; "02 / Paper: the questions candidates will get, in order, with marks").
   - A clear empty state for the paper.
   - Loading skeletons for both panes.
   - The ADDED state as a disabled-looking chip with a check.
   - Up, down and remove as labelled icon buttons.
   - The marks inputs aligned.
   - A sticky total bar ("Total 28 of 28 marks", green or cobalt when it matches, amber when not) with the Save button.
   - Fix any layout overflow seen in page3.png.
   - Keep the blueprint section (fair papers) below, clearly titled "03 / Fair papers (optional)".
4. **Candidates tab (item 9):** the three add methods (Quick add by email, Add one candidate, Import CSV) have inconsistent layouts: the first two stack vertically, the third sits beside the second. Make them three consistent, equal cards in one row on desktop (stacked on mobile). Each has a numbered title, a one-line purpose, its fields, and a primary action Button at the bottom in the same position. Keep all behaviour (dry run, invite links panel, enrol).
5. **Review and publish tab (item 10):** clearer buttons and layout.
   - A readiness checklist with ticks and crosses.
   - An action bar with "Preview as candidate" (secondary) and "Publish" (primary, hold or confirm), or, when already published, a clear status card "Published · paper frozen" with "Open monitor" and "Preview as candidate" Buttons (not a bare underlined link).
   - Fix the stray "." under the "Already published" text.
6. Check each screen in light AND dark at 1440 and 390 with the screenshot tools in C:/Users/umerf/AppData/Local/Temp/claude/46368f72d808e358/3d64d5b3-0eee-4935-9e2c-1276c595d01d/scratchpad: shots.mjs and shots-theme.mjs (examiner@invigil.app). Get exam ids from GET /api/v1/exams with the cached cookie. Read the PNGs and iterate.
`cd web && pnpm typecheck` must be clean. Write handoff/log/CX3.md, ending with `STATUS: COMPLETE`.
