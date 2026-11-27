import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * The primary call to action on a dashboard: the shared square Button (colour panel wipes across on hover),
 * rendered as a link. No pointer-following motion.
 */
export function CtaLink({
  href,
  children,
  tone = "ink",
  className,
}: {
  href: string;
  children: ReactNode;
  tone?: "ink" | "vermilion";
  className?: string;
}) {
  return (
    <Button asChild size="lg" variant={tone === "vermilion" ? "danger" : "primary"} className={className}>
      <Link href={href}>{children}</Link>
    </Button>
  );
}
