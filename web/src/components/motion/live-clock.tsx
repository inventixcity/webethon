"use client";

import { useEffect, useState } from "react";

const format = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

/** Renders only in the browser, because the server can't know the visitor's time zone. */
export function LiveClock({ className }: { className?: string }) {
  const [time, setTime] = useState<string>();

  useEffect(() => {
    const tick = () => setTime(format.format(new Date()));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <time aria-hidden="true" className={className}>
      {time ?? " "}
    </time>
  );
}
