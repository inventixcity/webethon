import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type SubmitButtonProps = Omit<React.ComponentProps<typeof Button>, "asChild"> & {
  pending?: boolean;
  /** Keeps the button off, for example while a rate limit counts down. */
  disabled?: boolean;
  pendingLabel: string;
};

export function SubmitButton({
  pending = false,
  pendingLabel,
  children,
  className,
  size = "lg",
  disabled = false,
  ...props
}: SubmitButtonProps) {
  return (
    <Button
      type="submit"
      size={size}
      disabled={pending || disabled}
      aria-busy={pending}
      className={cn("justify-between", className)}
      {...props}
    >
      {pending ? pendingLabel : children}
      <ArrowRight className="transition-transform duration-(--duration-base) ease-(--ease-enter) motion-reduce:transition-none group-hover/button:translate-x-1" />
      {pending && (
        <span
          aria-hidden="true"
          className="absolute bottom-0 left-0 h-0.5 w-1/3 animate-shuttle bg-vermilion motion-reduce:animate-none"
        />
      )}
    </Button>
  );
}
