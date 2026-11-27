"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The inline message for a form field. Renders nothing when there is no message.
 * Give the input `aria-describedby={id}` while the message is shown.
 *
 * The first time a message appears it has role="alert", so it is announced. Later changes
 * to the text are not announced again.
 */
export function FieldError({
  id,
  message,
  className,
}: {
  id: string;
  message?: string | null;
  className?: string;
}) {
  const [announced, setAnnounced] = useState(false);

  // Once a message has rendered, it has been announced. It becomes announceable again after it clears.
  useEffect(() => {
    setAnnounced(Boolean(message));
  }, [message]);

  if (!message) return null;

  return (
    <p
      id={id}
      role={announced ? undefined : "alert"}
      className={cn("mt-2 font-sans text-sm text-vermilion-deep", className)}
    >
      {message}
    </p>
  );
}
