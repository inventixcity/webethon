# CX7: Institute contact form (full stack), dark footer, landing mobile.
First read handoff/briefs/_common-ui.md.

The user said: "there is no contact form where institutes can reach us out to make their account" and "the footer needs improvement and make it in dark color".

You own:
- a NEW backend crate, backend/crates/exam_contact. Add it to the workspace members and mount it in backend/crates/server/src/lib.rs next to the other exam routers (only that line).
- a new migration in backend/migrations, numbered after the highest existing one
- web/src/app/contact/** (new)
- web/src/app/page.tsx (landing: the footer, a contact CTA section and the landing mobile layout)
- a new web/src/components/marketing/site-footer.tsx
- web/src/app/(admin)/admin/requests/** (new), and one "Requests" entry in the admin nav config
- on the login page, only one small link: "Need an account for your institute? Contact us"

## Backend
- **POST /api/v1/contact** (public).
  - Fields:
    - institute (2–160)
    - contactName (2–120)
    - email (valid)
    - phone (optional, 7–20 chars of digits, +, - and space)
    - role (optional, ≤ 80)
    - expectedCandidates (optional int, 1..1000000)
    - message (10–2000)
  - Use deny_unknown_fields.
  - Honeypot `website` must be empty. If it's filled, return 202 and store nothing.
  - Rate-limit with the existing Postgres limiter: 5 per hour per IP, 3 per day per email.
  - Store requests in the table institute_requests, with the same RLS lockdown as the other migrations. Columns:
    - id, institute, contact_name, email (citext), phone, role, expected_candidates, message
    - status: new | contacted | onboarded | declined
    - ip_hash (never the raw IP)
    - created_at, handled_by, handled_at
  - Through the existing mailer, email a notification to info@inventixhq.com and an acknowledgement to the requester. Escape all user text.
  - Always respond 202 `{data:{received:true}}`.
- **Admin endpoints.**
  - GET /api/v1/institute-requests: admin only, paginated, with a status filter.
  - PATCH /api/v1/institute-requests/{id} `{status}`, with an audit entry.
  - Non-admins get 404.
- **Tests:** validation, honeypot, rate limit, admin-only access and the audit entry.
  - Run fmt, `clippy --all-targets -D warnings` and the tests for your crate and server (`cd backend && bash scripts/cargo.sh …`).
  - Apply the migration locally: the API container migrates on start, so run `docker restart invigil-api-1`. Then exercise the endpoint with curl.

## Web
- **/contact page:**
  - an on-brand form using the shared Input, Label and Button
  - inline field errors, a success state, and errors via the toast stack
  - fits one laptop screen, and stays clean on mobile
  - linked from the landing page ("Bring Invigil to your institute"), the public nav and the footer
- **Footer:** a dark band with a near-black background in BOTH themes and paper-coloured text.
  - Columns:
    - brand plus a one-line pitch
    - Product links
    - For institutes (Contact us, Verify a result)
    - Contact details (from site.ts contact)
  - A bottom row with © 2026 Inventix Invigil and the Technoverse line.
  - Square, crisp, hairline rules, accents used sparingly.
  - Use it on landing, contact, verify and the other public pages.
- **Landing mobile:** everything stacks cleanly at 390px.
  - no overflow
  - the WaveText hero scales
  - figures are sized properly
  - no cramped text
- **/admin/requests:** a table (cards on mobile) with status chips and a status changer.
