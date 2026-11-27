import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";
const isProd = process.env.NODE_ENV === "production";

/*
 * 'unsafe-inline' scripts are needed for Next's inline bootstrap and the theme script.
 * React's dev tools need 'unsafe-eval', so that is development only.
 * lottie-web contains eval for After Effects expressions, but none of the shipped animations use one,
 * so production doesn't need 'unsafe-eval'. Add an animation with expressions and this has to change.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
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

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
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
      { source: "/:path*", headers: [...securityHeaders, { key: "Cache-Control", value: "no-store" }] },
      { source: "/_next/static/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
    ];
  },
};

export default nextConfig;
