### CX4 · pass 1 · 15:00 PKT
- Done:
  - Fixed the workspace scroll behavior in `web/src/components/workspace/workspace.tsx`. The scroll-layout initializer and question navigation now adjust only the question pane; `scrollIntoView()` could also scroll the document, moving the top bar away and leaving the viewport showing the dark page background as though the workspace had collapsed.
  - Removed the duplicate exam notification stack. The exam layout now provides a dedicated toast store, and the single `Toaster` stays inside the workspace root so it follows the workspace theme and fullscreen view.
  - Updated demo login buttons to show each role as its label, add `aria-label="Sign in as <role>"`, wrap safely, and use `lg:grid-cols-3`.
  - Added the requested contact details and landing footer attribution and copyright.
- Verified:
  - `cd web && pnpm typecheck` — passed (`tsc --noEmit`, no errors).
  - Sandbox Chrome flow, adapted from `scratchpad/ws-test.mjs`: examiner-created sandbox loaded in headless Chrome, answer selected online, second answer stored offline, then reconnect/sync. Output: `Saved` online and after sync; `Offline · 1 stored on device` while offline; 0 console errors; 0 failed requests. Before and after option-click screenshots showed the top bar and question pane at stable full height. Artifacts: `scratchpad/ws-cx4/1-loaded.png`, `2-answered-online.png`, `3-offline.png`, `4-reconnected.png`.
  - Real candidate Chrome flow, adapted from `scratchpad/ws-test.mjs`: created a local verification exam through the API, enrolled the demo candidate, published, started a real candidate attempt, then took over/loaded, saved online, stored offline, and reconnected. Output: `Saved` online and after sync; `Offline · 1 stored on device` while offline; 0 console errors; 0 failed requests. Artifact directory: `scratchpad/ws-candidate-cx4/`.
  - Login screenshots at 1280×720 and 1366×768: page content height exactly matched viewport at both sizes; role buttons fit on one screen. Artifacts: `scratchpad/cx4-login-1280/public_login.png`, `scratchpad/cx4-login-1366/public_login.png`.
  - Reviewed landing footer and login screenshots in light and dark themes, and workspace screenshots in dark theme. Artifacts: `scratchpad/cx4-footer-light/public_home.png`, `cx4-footer-dark/public_home.png`, `cx4-dark-login/public_login.png`, `scratchpad/ws-cx4-dark/1-loaded.png`.
- Open / known gaps: None.
- Requests to lead: None.

STATUS: COMPLETE
