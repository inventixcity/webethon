import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/*
 * The Content-Security-Policy is not set here. proxy.ts sends it with a fresh nonce on every request, so scripts
 * don't need 'unsafe-inline'. Keep one policy in one place.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }] : []),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keeps the page previews clean. Build errors still show their overlay.
  devIndicators: false,
  poweredByHeader: false,
  output: "standalone",
  async headers() {
    return [
      // Security headers everywhere. Pages and API responses are never cached; Next.js already serves its own
      // content-hashed build assets as immutable in production, so they are left to the framework (a custom
      // immutable rule here would also pin stale assets in development).
      { source: "/:path*", headers: securityHeaders },
      { source: "/((?!_next/|images/|lottie/|samples/|vendor/|favicon|icon).*)", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
