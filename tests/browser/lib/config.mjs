import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Origin of the web app (the Next.js server that also proxies /api/v1 to the Rust API). */
export const WEB_URL = (process.env.WEB_URL || "http://localhost:3000").replace(/\/+$/, "");
/** Origin of the Mailpit inbox that receives the app's email. */
export const MAILPIT_URL = (process.env.MAILPIT_URL || "http://localhost:8025").replace(/\/+$/, "");
/**
 * Optional shell command that clears the API's rate-limit counters before each test. The local stack allows
 * 6 sign-ups per IP per hour, and every browser shares one loopback IP, so a full run needs a reset. Leave it
 * unset for shared or production-like environments. See README.md.
 */
export const RATE_LIMIT_RESET_CMD = process.env.RATE_LIMIT_RESET_CMD || "";
/**
 * An account the API lists in ADMIN_EMAILS, for the admin specs (wave4-admin). Same variables as tests/e2e. The
 * admin specs skip with a reason when either is unset. See README.md.
 */
export const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim();
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

export const ARTIFACTS_DIR = join(here, "..", "artifacts");

/** Both themes the app ships. The value is stored in localStorage under "theme". */
export const THEMES = ["light", "dark"];

export const VIEWPORTS = {
  desktop: { width: 1366, height: 768 },
  phone: { width: 390, height: 844 },
};

export const LAUNCH_OPTIONS = {
  channel: "msedge",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
};

/**
 * The only 5xx responses the suite accepts. They come from features that are deliberately unconfigured in
 * local development (no AI provider key, no Stripe keys). The response body must also say NOT_CONFIGURED,
 * so a real outage on these paths still fails.
 */
export const ALLOWED_5XX = [
  { label: "AI provider not configured", url: /\/api\/v1\/ai\//, status: 503, code: "NOT_CONFIGURED" },
  { label: "Stripe/billing not configured", url: /\/api\/v1\/(payments|billing|checkout)/, status: 503, code: "NOT_CONFIGURED" },
];

/** Shared password for every account the suite creates. It meets the policy and is not a breached value. */
export const PASSWORD = "Correct horse battery 57!";

export function uniqueEmail(prefix = "browser") {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}+${Date.now().toString(36)}${random}@example.test`;
}
