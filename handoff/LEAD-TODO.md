# Lead TODO (fix after the owner finishes)
- [ ] S1 `store::upsert_answer`: typing telemetry must be ACCUMULATED (`typing = jsonb sum of old + new deltas`), not replaced. The client sends per-save deltas (`useTypingTelemetry().snapshot()` resets), and adding them also survives refreshes. Otherwise the composition-ratio indicator false-flags honest typists.
- [ ] Render deploy: needs RENDER_API_KEY from the user (or a Blueprint click), the GHCR image workflow (O1), and Vercel env.
- [ ] Final: `cargo fmt --all`, clippy, `pnpm build`, the e2e and security probes, push.
