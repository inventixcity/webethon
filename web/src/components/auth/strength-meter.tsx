import { passwordRules, passwordScore } from "@/features/auth/schemas";
import { cn } from "@/lib/utils";

const CELLS = 12;

export function StrengthMeter({ password, className }: { password: string; className?: string }) {
  const score = passwordScore(password);
  const filled = Math.round((score / passwordRules.length) * CELLS);

  return (
    <div className={className}>
      <div
        role="meter"
        aria-label="Password strength"
        aria-valuemin={0}
        aria-valuemax={passwordRules.length}
        aria-valuenow={score}
        className="grid grid-cols-12 gap-1"
      >
        {Array.from({ length: CELLS }, (_, cell) => (
          <span
            key={cell}
            style={{ transitionDelay: `${cell * 25}ms` }}
            className={cn(
              "h-2 origin-left transition-all duration-(--duration-slow)",
              cell < filled
                ? score === passwordRules.length
                  ? "bg-current"
                  : "bg-vermilion"
                : "bg-current opacity-15",
            )}
          />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] tracking-wide">
        {passwordRules.map((rule) => {
          const met = rule.test(password);
          return (
            <li key={rule.label} className={cn("transition-opacity", met ? "opacity-100" : "opacity-55")}>
              <span aria-hidden="true">{met ? "■" : "□"}</span> {rule.label}
              <span className="sr-only">{met ? " (met)" : " (not met)"}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
