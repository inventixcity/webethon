# CX8: Analytics screens, covering chart bugs, dark-mode readability and mobile. Web only.
First read handoff/briefs/_common-ui.md.

User doc, with screenshots in handoff/review/ui3/page1.png:
1. The Distribution chart title "Candidates by percentage band" overlaps the bar value labels (the row of zeros at the top), and the bars look broken.
2. In DARK mode, the amber topic-performance tiles and the amber flag chips (TOO HARD, OFTEN SKIPPED) have black text on orange that is hard to read. Light mode is fine.

You own web/src/components/analytics/**, web/src/app/(app)/app/examiner/exams/[examId]/analytics/**, and chart components used only by them.

Fix:
1. **Distribution chart:**
   - the title and legend never overlap values
   - value labels sit above bars only when > 0
   - clear axis labels
   - proportional bars, with a minimum visible height for non-zero values
   - a proper empty state
2. **Topic treemap in dark mode:** use a dark-tinted amber surface, or an amber outline with amber text on near-black, with text contrast ≥ 4.5:1. Give the cobalt and neutral bands the same treatment. The percent is big and legible, and the item count is readable.
3. **Flag chips:** readable in both themes. Compute the contrast ratios.
4. **Item analysis table:** stacked cards on mobile, a readable option breakdown, and a clear correct-answer badge.
5. **Check every analytics section** in both themes and at 390px, using the "Databases Final" and "Data Structures Midterm" exams.
