import { type NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIES } from "@/features/auth/session-cookie";

/*
 * Routing hints only. A session cookie's presence says nothing about whether it is still valid,
 * so /app re-checks with the API on every request (see features/auth/require-user.ts).
 *
 * Does nothing until the API is connected, so the design previews work exactly as before.
 */

const APP = "/app";
const EXAM = "/exam";
const SIGN_IN_PAGES = ["/login", "/signup"];

const isDev = process.env.NODE_ENV === "development";

/** A fresh, unguessable nonce for every request. Base64 of 16 random bytes. */
function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/*
 * Scripts need the nonce, so no 'unsafe-inline' here. React's dev tools need 'unsafe-eval', so that is
 * development only. lottie-web contains eval for After Effects expressions, but none of the shipped animations
 * use one, so production doesn't need 'unsafe-eval' either.
 */
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "worker-src 'self' blob:",
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = createNonce();
  const policy = contentSecurityPolicy(nonce);

  // Always replace the incoming values; layouts must never trust client-supplied ones.
  // Next.js reads the nonce from the request's CSP header and applies it to its own inline scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete("x-app-pathname");
  requestHeaders.set("x-app-pathname", request.nextUrl.pathname);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  const next = () => {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("Content-Security-Policy", policy);
    return response;
  };
  const { pathname, search, searchParams } = request.nextUrl;
  const signedIn = SESSION_COOKIES.some((name) => request.cookies.has(name));

  if (pathname === APP || pathname.startsWith(`${APP}/`) || pathname === EXAM || pathname.startsWith(`${EXAM}/`)) {
    // A cookie only means "maybe signed in"; the layouts verify the session with the API on every request
    // (features/auth/require-user.ts) and enforce the role there.
    if (signedIn) return next();
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  // A rejected cookie is marked session=expired by the app, so the visitor can sign in again instead of looping.
  if (SIGN_IN_PAGES.includes(pathname) && signedIn && searchParams.get("session") !== "expired") {
    const url = request.nextUrl.clone();
    url.pathname = APP;
    url.search = "";
    return NextResponse.redirect(url);
  }

  return next();
}

export const config = {
  matcher: [
    "/app/:path*",
    "/((?!api|_next/static|_next/image|favicon|kit|auth/|.*\\..*).*)",
  ],
};
