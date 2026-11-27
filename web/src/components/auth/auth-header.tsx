import Link from "next/link";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

type AuthHeaderProps = {
  index: string;
  section: string;
  className?: string;
};

export function AuthHeader({ index, section, className }: AuthHeaderProps) {
  return (
    <header
      className={cn(
        "flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-ink px-3 font-mono text-[11px] tracking-[0.14em] uppercase sm:px-5 md:px-8",
        className,
      )}
    >
      <Link href="/" className="flex min-h-11 min-w-0 items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center bg-ink text-xs font-bold text-paper">{siteConfig.mark}</span>
        <span className="truncate">{siteConfig.name}</span>
      </Link>
      <div className="flex shrink-0 items-center gap-1 sm:gap-4">
        <span className="hidden items-center gap-3 sm:flex">
          <span className="size-1.5 animate-blink bg-vermilion motion-reduce:animate-none" />
          {index} / {section}
        </span>
        <ThemeToggle className="min-h-11 min-w-11 uppercase" />
      </div>
    </header>
  );
}
