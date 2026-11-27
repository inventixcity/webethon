import type { Metadata } from "next";
import { Bricolage_Grotesque, JetBrains_Mono } from "next/font/google";
import { Toaster, ToastProvider } from "@/components/feedback/toaster";
import { ThemeScript } from "@/components/theme/theme-script";
import { siteConfig } from "@/config/site";
import { FlagsProvider } from "@/lib/flags";
import "./globals.css";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  axes: ["opsz", "wdth"],
  display: "swap",
});

const code = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-code",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: siteConfig.name, template: `%s · ${siteConfig.name}` },
  description: siteConfig.description,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The theme script sets data-theme before React loads, which React would otherwise flag.
    <html lang="en" className={`${display.variable} ${code.variable}`} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        <ToastProvider>
          <FlagsProvider>
            {children}
          </FlagsProvider>
          <Toaster />
        </ToastProvider>
      </body>
    </html>
  );
}
