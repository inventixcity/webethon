# CX9: Mobile pass for the app shell and examiner area. Web only.
First read handoff/briefs/_common-ui.md.

The user said: "almost all of the mobile UI is bad, cluttered and not responsive."

You own:
- web/src/components/app-shell/**
- web/src/components/ui/** (shared primitives; keep their APIs stable)
- web/src/components/exams/**, questions/**, monitor/**, grading/** and import/**
- web/src/app/(app)/app/examiner/** EXCEPT exams/[examId]/analytics/** (CX8) and exams/[examId]/results/** (CX6)
- web/src/app/globals.css

Goal at 360–430px (test 390x844 and 360x740), in both themes:
- **App shell:**
  - a proper mobile top bar with the logo, page title and a menu button
  - an accessible slide-in nav drawer: focus trap, Esc closes it, body scroll lock
  - user, theme, settings and sign-out inside the drawer
  - no sidebar eating width
- **PageHeader:** compact on mobile, with a smaller title and the figure as a short wide strip. Actions are full width and stacked.
- **Tab and filter bars:** horizontally scrollable with edge fades, never wrapping into a mess. Touch targets ≥ 44px.
- **Tables** (exam list, question bank, candidates, monitor board, grading) become stacked cards on mobile.
  - No horizontal page scroll anywhere: assert `document.documentElement.scrollWidth <= innerWidth` in your screenshot runs.
- **Forms** (new exam, question editor, candidates cards, review & publish) are a single column with comfortable spacing. Sticky action bars respect safe-area insets.
- **Text:** nothing under 12px on mobile, and less letter-spacing on long mono labels.

Shoot every examiner route at mobile in both themes, plus 1440 to make sure desktop didn't regress:
- overview, exams, new exam, question bank
- an exam's overview, questions, candidates, review, monitor, grading and disputes
