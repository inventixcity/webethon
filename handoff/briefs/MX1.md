# MX1: Exam setup forms and Questions editor: clear grouping and boxing (mobile first). Web only.
First read handoff/briefs/_common-ui.md.

The user's review is handoff/review/mobile2/Invigil_Today_UI_Issues.docx, with screenshots img01.png–img03.png in the same folder (open them).
Their words:
- "the instruction should have proper boxing around it"
- "main headings should be clearly separated from the description"
- "same issues of UI here"
- "there should be clarity and boxing for each thing"

You own web/src/components/exams/exam-form.tsx, web/src/components/exams/questions-editor.tsx and the blueprint (fair papers) components they use, plus the examiner new-exam and edit pages that render them. Do NOT edit exam-tabs.tsx, the exam detail header, or the review screens (MX2 owns those), the monitor (CX11) or settings (CX15).

Fix:
1. **Exam basics and Instructions (img01).**
   - Every text field and textarea gets a visible bordered box with padding and a clear focus state (cobalt outline). No underline-only fields in these forms.
   - Each section (Basics, Instructions, Schedule, Marks, Candidate rules, Status) is a distinct bordered card. Each card has a strong heading row (numbered mono eyebrow plus a bold title) clearly separated from its helper text; helper text and character counts sit BELOW the field.
2. **Schedule, marks, rules and status (img02).**
   - Group these into their own cards.
   - Keep the time-zone help next to the date fields.
   - Align numeric inputs (duration, pass marks) on a grid.
   - The candidate rules are toggles with labels and descriptions.
   - The status summary is a compact panel.
   - Save, Discard and the "Saved" feedback are grouped in one sticky action bar that respects the mobile safe area and never hides the last field (add bottom padding equal to the bar height).
3. **Questions editor (img03).**
   - The paper summary (marks total vs required, Save paper, saved state in a fixed spot beside Save) is its own container.
   - Fair papers is a separate container.
   - Each question row is one clearly bounded card: stem, topic chip, difficulty chip, marks input and the Add/Added control together.
   - On mobile, the controls wrap under the stem and nothing is lost while scrolling.
4. Both themes. Test at 320, 390 and 430 widths plus 1440: no horizontal scroll, and every control reachable. Screenshot /app/examiner/exams/new and an exam's /questions (a draft with questions, and one with none) at all those widths, in both themes. Read the PNGs and iterate.
