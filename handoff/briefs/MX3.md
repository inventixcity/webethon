# MX3: Full mobile responsiveness sweep (automated audit, then fixes). Web only.
First read handoff/briefs/_common-ui.md.

The user expects "many more issues in mobile layout and responsiveness". Find and fix them systematically.

## Step 1: build an audit tool
Create the audit tool in C:/Users/umerf/AppData/Local/Temp/claude/46368f72d808e358/3d64d5b3-0eee-4935-9e2c-1276c595d01d/scratchpad/mobile-audit.mjs, reusing the CDP approach in shots.mjs. For each route, role and width (320x640, 360x740, 390x844, 430x932) in both themes, it:
- loads the page signed in as the right role
- records `document.documentElement.scrollWidth > innerWidth` (horizontal overflow) and lists the elements whose bounding box extends past the viewport (tag, class, text snippet)
- finds text under 12px, tap targets under 40x40 (buttons, links, inputs), and overlapping interactive elements (bounding-box intersections)
- takes a screenshot
It writes a JSON and markdown report to handoff/reviews/mobile-audit.md.

Routes (get ids via the API):
- public: /, /contact, /verify, /verify/<code>, /login, /forgot-password
- candidate: /app/candidate, a lobby /app/candidate/exams/<id>, a result page, the exam workspace /exam/<attemptId>
- examiner: /app/examiner, /app/examiner/exams, /app/examiner/questions, exam overview/candidates/grading/disputes/results/analytics
- admin: /admin/users, /admin/audit, /admin/requests

## Step 2: fix everything the audit finds
You own those routes and their components, EXCEPT:
- exam-form, questions-editor and the blueprint UI (MX1)
- the exam header, exam-tabs and the review screens (MX2)
- the monitor and admin overview/system (CX11)
- settings (CX15)
- the backend
For an issue in an excluded area, list it in your log for the lead instead of editing.

Typical fixes:
- tables become stacked cards
- `min-w-0` and `break-words` on flex children
- long ids and emails truncated with a copy affordance
- chips and buttons wrap
- dialogs full-height on mobile
- sticky bars with safe-area insets
- 44px tap targets
- images with fixed aspect ratios
- no fixed widths

## Step 3: re-run the audit
Repeat until there's zero horizontal overflow on every route, at every width and theme, and the other issues are fixed or justified. Keep desktop (1440) unbroken; spot-check it. The final report lists before and after counts.
