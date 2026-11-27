import "server-only";

import { cookies } from "next/headers";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { getSessionUser, type SessionUser } from "@/lib/api/server";
import { SESSION_COOKIES } from "./session-cookie";

/**
 * Returns the signed-in user, or sends the visitor to sign in. Server components only.
 *
 * The proxy only checks that a session cookie exists. This is the real check, done by the API.
 */
export async function requireUser(): Promise<SessionUser> {
  // Pages call this too. Stops build-time prerender before the API is asked.
  await connection();
  const user = await getSessionUser();
  if (user) return user;

  // A cookie that the API rejected is stale (revoked on another device, or expired). Mark the redirect so
  // the proxy doesn't send the visitor straight back here from /login.
  const jar = await cookies();
  const hadCookie = SESSION_COOKIES.some((name) => jar.has(name));
  redirect(hadCookie ? "/login?next=/app&session=expired" : "/login?next=/app");
}
