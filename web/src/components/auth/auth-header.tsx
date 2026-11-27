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
        "flex h-14 shrink-0 items-center justify-between border-b border-ink px-5 font-mono text-[11px] tracking-[0.14em] uppercase md:px-8",
        className,
      )}
    >
      <Link href="/" className="flex items-center gap-3">
        <span className="grid size-7 place-items-center bg-ink text-xs font-bold text-paper">{siteConfig.mark}</span>
        {siteConfig.name}
      </Link>
      <div className="flex items-center gap-5">
        <span className="flex items-center gap-3">
          <span className="size-1.5 animate-blink bg-vermilion motion-reduce:animate-none" />
          {index} / {section}
        </span>
        <ThemeToggle className="min-h-6 min-w-6 py-1 uppercase" />
      </div>
    </header>
  );
}
