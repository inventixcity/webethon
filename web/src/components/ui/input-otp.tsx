"use client";

import { OTPInput, OTPInputContext } from "input-otp";
import * as React from "react";
import { cn } from "@/lib/utils";

function InputOTP({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string;
}) {
  return (
    <OTPInput
      data-slot="input-otp"
      containerClassName={cn("flex items-center has-disabled:opacity-60", containerClassName)}
      className={cn("disabled:cursor-not-allowed", className)}
      {...props}
    />
  );
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="input-otp-group" className={cn("flex items-center", className)} {...props} />;
}

function InputOTPSlot({
  index,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  index: number;
}) {
  const inputOTPContext = React.useContext(OTPInputContext);
  const { char, hasFakeCaret, isActive } = inputOTPContext?.slots[index] ?? {};

  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive || undefined}
      data-filled={char ? true : undefined}
      className={cn("relative flex items-center justify-center font-mono", className)}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-[30%] bottom-[22%] h-1.5 animate-blink bg-vermilion"
        />
      )}
    </div>
  );
}

export { InputOTP, InputOTPGroup, InputOTPSlot };
