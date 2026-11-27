# Invigil: 15-minute live demo

**Goal:** show that an exam survives a real failure without giving the candidate time, that the examiner stays in
control, and that the security claims hold on the live site.

**Setup before judges arrive**

- Production web: https://invigil-ivory.vercel.app. Confirm the API is awake at https://invigil-api.onrender.com/healthz.
  Open it once, because the free tier can cold-start.
- Demo sign-in buttons are shown (`NEXT_PUBLIC_DEMO_LOGINS=true`).
- Two browser windows: one as the examiner, one as a candidate in a private window.
- Have Chrome DevTools open on the candidate window (Network tab, for the offline toggle).
- The attempt you will use is one of the seeded `candidate01`–`candidate24` attempts, or start a fresh one in the
  demo exam before the session.
- Password for every demo account: `Invigil#Demo2026`.

## Run of show

| Time | Segment | What to do | What to say |
| --- | --- | --- | --- |
| 0:00 | **Problem and landing** (1:30) | Open the landing page. Let the hero finish. | Online exams fail unfairly. A dropped connection either loses answers or hands cheats free time. Invigil refuses both. |
| 1:30 | **Examiner sets up** (1:30) | Sign in as `examiner@invigil.app`. Open the question bank, show the import dry run (CSV), then open an exam and walk the Review checklist. Publish. | Publishing snapshots the paper, so editing the bank later never changes a live exam. |
| 3:00 | **Enrolment** (1:30) | Open Candidates. Show the enrolment import and an invite. Point out that candidates are invited, not self-registered. | Self sign-up is off. Accounts are provisioned by people. |
| 4:30 | **The candidate workspace** (2:30) | In the private window, sign in as the candidate, open the lobby, start the attempt. Show the server countdown and the save pill. Type an answer. | The clock is the server's. The browser never decides the deadline. |
| 7:00 | **Dropped connection** (2:00) | In DevTools, set the window to Offline. Keep answering. Reload the page while offline. Set it back to Online. Watch *Offline*, then *Syncing*, then *Saved*. | Every answer is on the device before it is sent. The reload restored them, and the clock kept running. |
| 9:00 | **Outage and credit** (2:00) | In the examiner window, open Monitor. Show the verified outage on the incident panel. Grant a time credit for that outage with a reason. Then try a larger credit and show the refusal (`credit_cap`). | Only a person can grant time, only for an outage the server saw, and only up to its length. Every grant is audited. |
| 11:00 | **Integrity indicators** (1:30) | On Monitor, show the review priority and the plain-language indicators. Paste a question stem into the leak tracer and show the attempt it traces to. | These are indicators for review, not evidence. We record counts, never content, and never the camera. |
| 12:30 | **Grading and results** (1:30) | Grade a written answer with feedback. Publish results. Open the candidate's result, then the public verify page with the certificate code. | The certificate is signed. Change one character in the record and verification fails. |
| 14:00 | **Security proof** (1:00) | In DevTools on the candidate window, show the `__Host-session` cookie flags and a response header set. On the sign-in page, request a password reset for a real and an unknown address and show the identical response. | Headers, cookies and reset behaviour are checked on the live site, not just in code. |
| 15:00 | **Questions** | Take questions from the judges. | |

If time runs short, cut the analytics mention and keep segments 7:00 and 9:00 intact. They are the core claim.

## Likely judge questions

**Can a candidate gain time by going offline?**
Not in any way that matters. The deadline is fixed on the server and never pauses. Offline answers are journaled and
synced. An answer stamped after the deadline is rejected. Entries stamped before it can arrive up to 90 seconds late,
and only if the device had gone silent in the last 30 seconds before the deadline. Those entries are flagged for the
examiner. That is the honest residual: we cannot prove when an offline browser wrote an answer, so we bound it at 90 s.

**Why not let the timer pause during an outage?**
A pause is a free pause for a cheat. An automatic pause is also unauditable. We pair the fixed timer with a
human-granted credit that is tied to an outage the server recorded and capped at its length. Nothing is automatic.

**How does the server know there was an outage?**
Each heartbeat is recorded when the server receives it. A gap of 45 seconds or more is a verified outage. A client can't
create a gap after the fact, because a gap only exists when the server heard nothing.

**What stops two people sharing one exam?**
One active device per attempt. A takeover is explicit, rate limited and recorded as an incident, and the old device is
locked out at once. A second physical device, such as a phone beside the laptop, is invisible to any browser system. We
say so openly.

**Why no webcam or screen recording?**
It's invasive, inaccessible on slow connections, and produces false accusations. We collect counts and durations and
label everything as an indicator. Deterrence is weaker against a determined cheater, and that trade-off is deliberate.

**Does the AI tooling detect cheating?**
There is no AI in the exam path. The AI routes are not mounted, so there are no model calls and no spend. The AI canary
is an opt-in, invisible prompt hidden from assistive technology. A hit is only an indicator.

**Can an examiner or admin change a grade or result without a trace?**
Every examiner and admin change is audited with the actor and target. Results are signed, so the public verify page
detects an edited record. Unpublishing revokes the certificate rather than deleting it.

**Is the data safe if the database leaks?**
Passwords are Argon2id. Session tokens, invite tokens and codes are stored hashed. The Supabase database has row-level
security on every table with the public API grants revoked, so the public REST endpoint can't read it.

**How do you know the production site matches the code?**
We checked it live on 27 November: security headers, cookie flags, the identical reset response, the absence of upload
and AI routes, and the signed certificate. The local end-to-end flow passes 43 of 43 checks. The full list is in
[SECURITY.md](SECURITY.md) and [AUDIT-RESPONSE.md](AUDIT-RESPONSE.md).

**What is still open?**
Three things. The CSP still allows inline scripts, and a nonce-based version is in progress. A full accessibility
audit hasn't been done. And the offline authorship gap is a stated residual. The demo credentials are shared on purpose
for judging, and they're fictional.

**Why Rust and Postgres, not a BaaS?**
Authorization, timing and grading are the product. Keeping them in one typed Rust API, with the database behind it,
makes each invariant testable, and Supabase is used only as hosted Postgres with its public API locked down.

**Will it scale to a real sitting of hundreds?**
The API is stateless except for an in-process paper cache, which each replica warms on its own. The database holds all
exam state, and the sweep uses `skip locked` so several replicas can run it. The free tiers we use now are for the
hackathon. A production deployment needs paid tiers and a load test, and we haven't run one.

**What happens to my answers if the server is down?**
They stay on the device in the journal until the server is back, up to the grace limits. If the device itself is lost
before it syncs, those offline answers are lost, and takeover lets the candidate continue from the last synced state.

**What does a real deployment need?**
Individual accounts created by an admin, examiner invites, candidate enrolment, `NEXT_PUBLIC_DEMO_LOGINS=false`, and the
production secrets listed in the README. The demo seed never runs there.
