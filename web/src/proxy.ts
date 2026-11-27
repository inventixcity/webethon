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

export function proxy(request: NextRequest) {
  // Always replace the incoming value; layouts must never trust a client-supplied pathname.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete("x-app-pathname");
  requestHeaders.set("x-app-pathname", request.nextUrl.pathname);
  const next = () => NextResponse.next({ request: { headers: requestHeaders } });
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
