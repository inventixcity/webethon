# MX2: Exam header, status, tabs and Review & publish (mobile first). Web only.
First read handoff/briefs/_common-ui.md.

The user's review is handoff/review/mobile2/Invigil_Today_UI_Issues.docx, with screenshots img04.png–img07.png in the same folder (open them).
Their words:
- "this UI can be changed to something with a background, or bold, or in a different style; it looks merged"
- "more colours need to be added on this screen"
- "this design is also not ok"
- "the UI above isn't right either" (the mobile header)

You own:
- the exam detail header (web/src/app/(app)/app/examiner/exams/[examId]/layout.tsx and the components it renders for the title, status, window and duration)
- web/src/components/exams/exam-tabs.tsx
- the Review & publish route and its components (readiness checklist, marks, question mix)
- in web/src/components/app-shell/**, ONLY the mobile top-bar title/section label
Do NOT edit exam-form or questions-editor (MX1), the monitor (CX11), settings (CX15) or the admin pages.

Fix:
1. **Exam header (img04).**
   - The exam summary (status, window, duration) is a distinct panel with a tinted background and border: a bold mono label above each value, a status chip, and good contrast in both themes.
   - Separate it from the tabs with spacing and a rule.
   - Long titles wrap cleanly (at most 3 lines, then ellipsis with the full title in a title attribute) and never overlap anything.
   - The active tab stays prominent.
2. **Mobile top bar (img07).**
   - The current page title or section label must not crowd: truncate with an ellipsis, a single line, and safe-area padding.
   - Give the review instructions their own space below the header.
3. **Review & publish (img05).**
   - Readiness items use consistent colour, icon and text: Pass (cobalt or green check), Fix (vermilion cross), Note (amber info).
   - "Publish paper" is the PRIMARY filled action when available; when blocked, it's disabled with the blocker explained right beside it.
   - "Preview as candidate" is secondary (outline).
   - A summary strip at the top shows "3 to fix · 1 note · 6 passed".
4. **Marks and question mix (img06).**
   - Assigned vs required marks, with the mismatch, go in a compact panel with a meter.
   - When there are no assigned questions, show ONE clear empty message, "Add questions to see the topic and difficulty breakdown", with a link to Questions, instead of two "No data for this period" blocks.
   - Show both breakdowns once questions exist.
5. **Retest checklist from the doc:**
   - At 320, 390 and 430 px, the title, tab labels and save controls stay readable and reachable.
   - In light and dark, check section borders, focus, active tabs and the Pass/Fix indicators.
   - Review a draft with no questions, one with a marks mismatch, and a complete paper (create test drafts through the API as examiner@invigil.app if needed).
   Screenshot each case. Read the PNGs and iterate.
