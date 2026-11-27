/**
 * The sign-in, sign-up and reset calls the screens make.
 *
 * Real calls go through the same-origin /api/v1 proxy. Until the API is connected (NEXT_PUBLIC_API_ENABLED
 * isn't "true"), and on the /auth/<set>/ design previews, each function runs a simulation instead, so every
 * page and state can still be reviewed. In the simulation nothing is sent anywhere and no account is created.
 *
 * Every failure is thrown as an ApiError, unchanged. The screens pass it to describeError, which picks the
 * plain copy. Nothing here writes user-facing text.
 *
 * To see the error states in the simulation: use the password "wrong" to sign in, "limit" for a rate limit,
 * or the code 000000 to verify.
 *
 * A function that ends in a full page change never resolves. That keeps the form in its pending state while
 * the browser navigates away.
 */
import { api, ApiError } from "@/lib/api/client";
import { destinationAfterSignIn } from "./redirects";
import { emailSchema, type LoginValues, type SignupValues } from "./schemas";

function redirectMfa(cause: unknown): Promise<never> | undefined {
  if (!(cause instanceof ApiError) || cause.code !== "MFA_REQUIRED") return;
  const details = cause.details;
  if (!details || typeof details !== "object" || !("mfaToken" in details) || typeof details.mfaToken !== "string" || !details.mfaToken) return;
  const params = new URLSearchParams({ mfa: details.mfaToken });
  const next = new URLSearchParams(window.location.search).get("next");
  if (next && next !== "reset") params.set("next", next);
  return navigate(`/verify?${params}`);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function simulated() {
  return process.env.NEXT_PUBLIC_API_ENABLED !== "true" || /^\/auth\/\d+\//.test(window.location.pathname);
}

/** Leaves the page. The promise never settles, so the caller's form stays pending until the page changes. */
function navigate(url: string): Promise<never> {
  window.location.assign(url);
  return new Promise<never>(() => {});
}

/** An error this page raises itself. The code picks the copy from the shared catalogue. */
function localError(code: string, status: number): ApiError {
  return new ApiError({ code, status, message: code });
}

/** POSTs to an auth endpoint. Errors reach the caller unchanged. */
async function send<T = void>(path: `/auth/${string}`, body?: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body });
}

/** Email and purpose for the verify screen, read from its URL: /verify?email=...&next=reset */
function verification(): { email: string; purpose: "verify_email" | "reset_password" } {
  const params = new URLSearchParams(window.location.search);
  const parsed = emailSchema.safeParse(params.get("email")?.trim());
  if (!parsed.success) throw localError("BAD_REQUEST", 400);
  return {
    email: parsed.data,
    purpose: params.get("next") === "reset" ? "reset_password" : "verify_email",
  };
}

export async function signIn(values: LoginValues): Promise<void> {
  if (simulated()) {
    await wait(900);
    // Wrong password and unknown email answer the same way, so the copy never says which one it was.
    if (values.password === "wrong") throw localError("INVALID_CREDENTIALS", 401);
    if (values.password === "limit") {
      throw new ApiError({ code: "RATE_LIMITED", status: 429, message: "Too many attempts", retryAfter: 30 });
    }
    return;
  }

  try {
    await api("/auth/signin", { method: "POST", body: { email: values.email, password: values.password } });
  } catch (cause) {
    const redirect = redirectMfa(cause);
    if (redirect) return redirect;
    throw cause;
  }
  return navigate(destinationAfterSignIn());
}

export async function signInWithProvider(provider: "google" | "github"): Promise<void> {
  if (simulated()) {
    await wait(900);
    return;
  }
  // The API starts the OAuth dance and redirects back to the requested path once the session is set.
  return navigate(`/api/v1/auth/oauth/${provider}/start?next=${encodeURIComponent(destinationAfterSignIn())}`);
}

export async function signInAsDemo(): Promise<void> {
  if (simulated()) {
    await wait(700);
    return;
  }
  try {
    await api("/auth/demo", { method: "POST" });
  } catch (cause) {
    const redirect = redirectMfa(cause);
    if (redirect) return redirect;
    throw cause;
  }
  return navigate(destinationAfterSignIn());
}

export async function signUp(values: SignupValues): Promise<void> {
  if (simulated()) {
    await wait(1100);
    return;
  }
  // The API answers 202 whether or not the address is new, so nothing here reveals who has an account.
  await send("/auth/signup", { name: values.name, email: values.email, password: values.password });
}

export async function requestReset(email: string): Promise<void> {
  if (simulated()) {
    await wait(900);
    return;
  }
  // Also answers 202 whatever the address, for the same reason as signup.
  await send("/auth/password/forgot", { email });
}

export async function verifyCode(code: string): Promise<void> {
  const mfaToken = new URLSearchParams(window.location.search).get("mfa");
  if (mfaToken) {
    await send("/auth/mfa/verify", { mfaToken, code });
    return navigate(destinationAfterSignIn());
  }
  if (simulated()) {
    await wait(800);
    if (code === "000000") throw localError("INVALID_CODE", 400);
    return;
  }

  const { email, purpose } = verification();
  if (purpose === "reset_password") {
    // The API sets the HttpOnly reset cookie here. The page never holds the reset token, so nothing is stored.
    // Resolves, so the verify hook can move on to the reset screen itself.
    await send("/auth/password/verify-code", { email, code });
    return;
  }

  await send("/auth/verify-email", { email, code });
  return navigate(destinationAfterSignIn());
}

export async function resendCode(): Promise<void> {
  // Authenticator codes can't be resent. The verify hook explains this before it gets here.
  if (new URLSearchParams(window.location.search).has("mfa")) throw localError("BAD_REQUEST", 400);
  if (simulated()) {
    await wait(600);
    return;
  }
  const { email, purpose } = verification();
  await send("/auth/resend-code", { email, purpose });
}

export async function resetPassword(password: string): Promise<void> {
  if (simulated()) {
    await wait(1000);
    return;
  }

  // The reset cookie (Path=/api/v1/auth/password, HttpOnly) carries the grant, so no token goes in the body.
  try {
    await api("/auth/password/reset", { method: "POST", body: { password } });
  } catch (cause) {
    const redirect = redirectMfa(cause);
    if (redirect) return redirect;
    throw cause;
  }
  // The reset signs the person in, so they go straight to the app.
  return navigate(destinationAfterSignIn());
}
