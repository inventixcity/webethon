# Research notes behind Invigil's design

Short notes on the sources that shaped the integrity (5.1) and resilience (5.3) features, and how each one is used.

## AI canary (hidden instruction in the question text)
- Instructors have embedded invisible instructions (for example a nonsense keyword) in assignment prompts. A candidate who pastes the prompt into a chatbot carries the instruction along, and the answer reveals it. A 2026 preprint formalises this as *seeding watermarks in the prompt*, because the examiner can't watermark the model's output directly. [arXiv 2605.16336](https://arxiv.org/abs/2605.16336)
- DoPE (decoy-oriented perturbation) embeds decoys in exam documents and reports high detection on commercial models. [arXiv 2601.12505](https://arxiv.org/html/2601.12505v1)
- Known limits: screenshots and OCR defeat it, and reported cases raise fairness concerns, including dark-mode visibility and students who weren't told.
- **Invigil's choices:**
  - The canary is off by default, and the examiner opts in.
  - It's `aria-hidden` and visually hidden, so screen-reader users never meet it.
  - Candidates are told in the integrity notice that hidden markers may be present.
  - A hit is an *indicator* (weight 5) that raises review priority, never an automatic penalty.

## Typing telemetry (paste and composition ratio)
- Keystroke dynamics separate genuine writing from AI-assisted writing better than text-only detectors, which perform near chance. [Kundu et al., IJCB 2024, arXiv 2406.15335](https://arxiv.org/abs/2406.15335) · [arXiv 2511.12468](https://arxiv.org/abs/2511.12468) · [arXiv 2507.22956](https://arxiv.org/abs/2507.22956)
- Privacy-light adaptation: Invigil records **counts only** (keystrokes, pastes, pasted characters, active time), never keys or content. It flags the composition ratio (final length compared with keystrokes and pasted characters). No biometric profile is built.

## Collusion indicator (identical wrong answers)
- The Harpp–Hogan (1993) response-similarity ratio is the share of commonly missed items on which two candidates chose the *same wrong option*, with a 0.75 cutoff. Later work cautions that such indices are screening tools with false positives, especially on short tests. [Assessment Systems summary](https://assess.com/harpp-and-hogan-1993-response-similarity-index/) · [Nelson 2006 review](https://www2.psych.ubc.ca/~dellab/cheatingprograms/Nelson%20review%20JERM2006.doc) · [arXiv 1409.7675](https://arxiv.org/pdf/1409.7675)
- **Invigil:** ratio >= 0.75 *and* at least 3 identical wrong answers. Shown only to the examiner, labelled as an indicator for human review.

## Leak tracing (invisible watermark)
- Each candidate's copy of a stem carries zero-width characters encoding their attempt id. If question text leaks to a group chat or forum, the examiner pastes it into the tracer to identify the source attempt. It survives copy-paste, but not retyping or screenshots (documented limit).

## Session security
- The session cookie is `__Host-session`: `Secure`, `Path=/`, no `Domain`, `HttpOnly`, `SameSite=Lax`. The token is random (256 bits), and only its SHA-256 is stored server-side. This follows OWASP ASVS 5.0 V3.3 and the WSTG cookie tests. [OWASP WSTG: cookie attributes](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/06-Session_Management_Testing/02-Testing_for_Cookies_Attributes) · [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)

## Failure resilience (5.3)
- **Server-authoritative time:** the deadline is fixed by the server at start and moves only through an audited credit.
- **Offline journal:** a hash chain in the style of tamper-evident logs, `h_n = SHA-256(h_{n-1} || entry)`, starting from a server-random genesis value.
- **Time leases:** signed with HMAC-SHA-256, so a client can prove "I was alive at server time T" without the server trusting its clock. Elapsed time since the lease is measured with the monotonic clock (`performance.now()`), and is bounded by real time at receipt and by the deadline.
