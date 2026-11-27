import { cn } from "@/lib/utils";

type RevealProps = {
  children: React.ReactNode;
  delay?: number;
  className?: string;
};

/** Slides content up from behind a mask. Wrap each line or word separately to stagger them. */
export function Reveal({ children, delay = 0, className }: RevealProps) {
  return (
    <span className={cn("inline-block overflow-hidden pb-[0.12em] align-bottom", className)}>
      <span className="reveal-content inline-block" style={{ animationDelay: `${delay}s` }}>
        {children}
      </span>
    </span>
  );
}
