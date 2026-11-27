CONTINUE. You stopped early, but your brief is not complete. Keep working until EVERY item in your brief is implemented, compiles and is tested. Do not stop at partial work.
Updates from the lead:
- The workspace loads again (a crate was briefly missing mid-edit). `examcore` now re-exports `AppError, AppResult, AppState, ErrorCode, Viewer`. `auth::password` is now `pub`. All exam crates have the base64, rand, hex, sha2 and futures deps.
- Always verify with `-p <your crate>` (`bash scripts/cargo.sh check -p <crate>`). Other crates being broken does not block you, unless your crate depends on them. If a dependency crate is broken, wait 60 s and retry, up to 10 times, and keep writing your own code in the meantime.
- If the workspace fails to load because another member's manifest or lib.rs is momentarily missing, wait 30 s and retry. That is transient.
- Write normally formatted, readable Rust (one statement per line). Run `bash scripts/cargo.sh fmt -p <crate>` before you finish. Judges read this code.
- When fully done, update your log in handoff/log/<ID>.md.
- When (and only when) everything in your brief is done, compiled and tested, put a line `STATUS: COMPLETE` as the LAST line of handoff/log/<ID>.md. Until then, end your log with `STATUS: IN PROGRESS` plus the remaining items. You will be resumed automatically until it says COMPLETE.
- **Response envelope (affects everyone):** every successful JSON response must be `{"data": <payload>}`. `ResponseJson` is plain `axum::Json` and does NOT wrap. Use `examcore::ok(payload)` (returns `axum::Json<Value>`) with the handler return type `examcore::ApiJson`. Fix any handler that returns a bare payload.
- Read `handoff/reviews/R1-*.md` for findings in your crate or files and fix them all.
