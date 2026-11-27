import { BadgeCheck, Clock, EyeOff, LockKeyhole, ScrollText, ShieldCheck, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Card = { label: string; title: string; text: string; icon: LucideIcon; rule: "cobalt" | "amber" };

const CARDS: readonly Card[] = [
  {
    label: "Server",
    title: "Checked on the server",
    text: "Every request is authorised in the API against the signed-in role and ownership. Hiding a page is never the protection.",
    icon: ShieldCheck,
    rule: "cobalt",
  },
  {
    label: "Answers",
    title: "Answer keys stay put",
    text: "Correct answers, rubrics and explanations are never sent to a candidate before results are published.",
    icon: EyeOff,
    rule: "amber",
  },
  {
    label: "Time",
    title: "Server time only",
    text: "Deadlines, leases and submissions use the server clock. Device clocks are informational.",
    icon: Clock,
    rule: "cobalt",
  },
  {
    label: "Sign-in",
    title: "Strong sign-in",
    text: "Passwords are hashed with Argon2id. Sessions live in HttpOnly cookies, and writes are checked against cross-site requests.",
    icon: LockKeyhole,
    rule: "amber",
  },
  {
    label: "Audit",
    title: "Audited changes",
    text: "Examiner and admin actions are written to an audit log, with no answer content and no secrets.",
    icon: ScrollText,
    rule: "cobalt",
  },
  {
    label: "Results",
    title: "Signed results",
    text: "Every certificate carries an Ed25519 signature, so its authenticity can be checked by anyone.",
    icon: BadgeCheck,
    rule: "amber",
  },
];

/** Six security controls as a 3 by 2 grid of cards. Hover changes only the border colour, nothing moves. */
export function SecurityCards({ className }: { className?: string }) {
  return (
    <ul className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-3", className)}>
      {CARDS.map((card, index) => {
        const Icon = card.icon;
        return (
          <li
            key={card.title}
            className={cn(
              "grid content-start gap-5 border border-rule border-t-2 bg-paper p-6 transition-colors duration-200 md:p-7 motion-reduce:transition-none",
              card.rule === "cobalt" ? "border-t-cobalt" : "border-t-amber",
              "hover:border-x-ink hover:border-b-ink",
            )}
          >
            <div className="flex items-center justify-between gap-4 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
              <span className="tabular-nums">
                {String(index + 1).padStart(2, "0")} / {card.label}
              </span>
              <Icon aria-hidden="true" className="size-5 text-ink" strokeWidth={1.5} />
            </div>
            <div className="grid gap-2">
              <h3 className="text-xl font-medium tracking-[-0.01em]">{card.title}</h3>
              <p className="text-sm leading-relaxed text-ink-soft">{card.text}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
