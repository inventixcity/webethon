# Admin client contracts

The payments and places screens target planned endpoints; their list shapes and filters must be confirmed against the domain implementation. Lists request `limit=25`, optional `cursor`, and optional `q`, and expect `{data: [...], meta: {nextCursor}}`.

- `POST /admin/payments/entitlements/grant`: `{userId, productId, expiresAt?}`; expiry is an ISO timestamp.
- `POST /admin/payments/entitlements/revoke`: `{userId, productId}`.
- `POST /admin/places/{id}/hide`: no body.
- These actions require step-up and return 204. Purchases may provide `stripeDashboardUrl` or `dashboardUrl`; only HTTPS links to `dashboard.stripe.com` are shown.
- Transfer sends `{userId}`; content moderation, comment moderation, booking cancellation, and file deletion send no body.

No refund or impersonation API is used. The browser probe in `scripts/admin-browser-probe.mjs` accepts `ADMIN_STATE` and `USER_STATE` Playwright storage-state paths and never prints their contents. Its simulated states are explicitly labeled and do not establish backend coverage.
