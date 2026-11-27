import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

/*
 * Square corners, Ivory & Ink tokens only. See docs/DESIGN.md, "Buttons and motion".
 * Durations and easings come from the motion tokens in globals.css (--duration-*, --ease-*).
 */

// Filled variants wipe a colour panel across on hover. It is a transform, so it costs nothing to paint.
const wipe =
  "before:absolute before:inset-0 before:-z-10 before:origin-left before:scale-x-0 before:transition-transform before:duration-(--duration-slow) before:ease-(--ease-enter) hover:before:scale-x-100 motion-reduce:before:transition-none";

// Disabled filled buttons drop to a neutral panel with a rule-coloured inset outline. No opacity: opacity dims the label
// too, and the label has to keep 4.5:1 in both themes. Busy buttons (loading, or aria-busy) do not get this look.
const disabledFilled =
  "data-[disabled=true]:bg-paper-sunk data-[disabled=true]:text-ink-soft data-[disabled=true]:shadow-[inset_0_0_0_1px_var(--ink-muted)] data-[disabled=true]:before:hidden";

// Loading hides the label without changing the width, and draws a square spinner in its place.
// The label uses -webkit-text-fill-color, not colour, so the spinner keeps the current text colour.
const loading =
  "data-[loading=true]:pointer-events-none data-[loading=true]:[-webkit-text-fill-color:transparent] data-[loading=true]:[&_svg]:invisible data-[loading=true]:after:absolute data-[loading=true]:after:top-1/2 data-[loading=true]:after:left-1/2 data-[loading=true]:after:size-4 data-[loading=true]:after:-translate-x-1/2 data-[loading=true]:after:-translate-y-1/2 data-[loading=true]:after:animate-spin data-[loading=true]:after:border-2 data-[loading=true]:after:border-current data-[loading=true]:after:border-r-transparent data-[loading=true]:after:content-['']";

const buttonVariants = cva(
  [
    "group/button relative isolate inline-flex shrink-0 cursor-pointer items-center justify-center gap-3 overflow-hidden whitespace-nowrap",
    "font-mono text-xs font-medium tracking-[0.12em] uppercase",
    "transition-[color,background-color,border-color,translate,box-shadow] duration-(--duration-base) ease-(--ease-enter)",
    "active:translate-y-px motion-reduce:transition-none motion-reduce:active:translate-y-0",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion",
    // data-disabled is set only for truly disabled buttons (never while busy). Busy buttons take no pointer events.
    "data-[disabled=true]:pointer-events-none data-[busy=true]:pointer-events-none",
    loading,
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ].join(" "),
  {
    variants: {
      variant: {
        // Filled variants: disabled is the neutral panel (disabledFilled).
        // Outline and text variants: disabled changes the text colour only, never the fill.
        primary: `bg-ink text-paper before:bg-vermilion-deep ${wipe} ${disabledFilled}`,
        secondary: `border border-ink text-ink before:bg-ink hover:text-paper ${wipe} data-[disabled=true]:border-rule data-[disabled=true]:text-ink-soft`,
        danger: `bg-vermilion-deep text-paper before:bg-ink ${wipe} ${disabledFilled}`,
        ghost: "text-current underline-offset-4 hover:bg-paper-sunk hover:underline data-[disabled=true]:text-ink-soft",
        link: "h-auto! overflow-visible! p-0! text-current underline underline-offset-4 hover:text-vermilion-deep data-[disabled=true]:text-ink-soft",
        // For paper-on-ink panels. Keep these for existing call sites; use the variants above elsewhere.
        inverse: `bg-paper text-ink before:bg-vermilion-deep hover:text-paper ${wipe} ${disabledFilled}`,
        "outline-inverse": `border border-paper/40 text-paper before:bg-paper hover:text-ink ${wipe} data-[disabled=true]:text-paper/60`,
        // Legacy names, kept so existing call sites compile. They render exactly as the new names do.
        // @deprecated use primary.
        default: `bg-ink text-paper before:bg-vermilion-deep ${wipe} ${disabledFilled}`,
        // @deprecated use secondary.
        outline: `border border-ink text-ink before:bg-ink hover:text-paper ${wipe} data-[disabled=true]:border-rule data-[disabled=true]:text-ink-soft`,
        // @deprecated use danger.
        destructive: `bg-vermilion-deep text-paper before:bg-ink ${wipe} ${disabledFilled}`,
      },
      size: {
        sm: "h-10 px-4",
        md: "h-12 px-5",
        lg: "h-14 px-6",
        icon: "size-12",
        // @deprecated use md.
        default: "h-12 px-5",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Renders the child element (a Link, for example) with the button's styles. */
    asChild?: boolean;
    /** Shows a spinner in place of the label. The width stays the same and the button stops taking clicks. */
    loading?: boolean;
  };

// No event handlers are created here, on purpose: this component is also rendered in server components,
// and React cannot serialise a handler that the server builds. An inert link is removed from the tab order
// and loses pointer events, so it cannot be activated either.
function Button({
  className,
  variant = "primary",
  size = "md",
  asChild = false,
  loading = false,
  disabled = false,
  type = "button",
  "aria-busy": ariaBusy,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  const inert = disabled || loading;
  // Busy means loading, or a caller that sets aria-busy (SubmitButton while pending). A busy button still
  // blocks clicks and double submit, but keeps its variant's solid look, so it is not drawn as disabled.
  const busy = loading || ariaBusy === true || ariaBusy === "true";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-disabled={disabled && !busy ? "true" : undefined}
      data-busy={busy ? "true" : undefined}
      data-loading={loading ? "true" : undefined}
      aria-busy={busy || undefined}
      {...(asChild
        ? { "aria-disabled": inert || undefined, tabIndex: inert ? -1 : undefined }
        : { type, disabled: inert })}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
export type { ButtonProps };
