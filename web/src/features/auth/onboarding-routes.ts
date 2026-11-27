/** Routes that must remain reachable while onboarding is incomplete. */
export function isOnboardingExempt(pathname: string): boolean {
  return ["/app/onboarding", "/app/settings", "/app/signout", "/app/logout", "/app/session"].some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}
