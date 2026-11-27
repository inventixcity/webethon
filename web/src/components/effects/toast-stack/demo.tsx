"use client";

import { useEffect } from "react";
import { DemoFrame } from "../demo-frame";
import { ToastProvider, useToast } from "./toast-stack";

function Triggers() {
  const { show, update } = useToast();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      show({ tone: "success", title: "Changes saved", body: "Everyone on your team can see them now.", duration: 9000 });
      show({ title: "Sam joined the project", duration: 9000 });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [show]);

  const actions = [
    {
      label: "Success",
      run: () => show({ tone: "success", title: "Invite sent", body: "We've emailed a link to join the team." }),
    },
    {
      label: "Error",
      run: () => show({ tone: "error", title: "Payment failed", body: "Your card was declined, so nothing was charged." }),
    },
    {
      label: "Loading",
      run: () => {
        const id = show({ tone: "loading", title: "Uploading report", body: "This takes a few seconds." });
        window.setTimeout(() => update(id, { tone: "success", title: "Report uploaded", body: "It's ready to share." }), 2400);
      },
    },
    {
      label: "Error + id",
      run: () =>
        show({
          tone: "error",
          title: "Could not save the exam",
          body: "The server did not respond. Your changes are still here, so try again.",
          requestId: "req_7f3a9c21b04e",
          action: { label: "Try again", onClick: () => show({ tone: "info", title: "Retrying" }) },
        }),
    },
    {
      label: "With undo",
      run: () =>
        show({
          title: "Project archived",
          action: { label: "Undo", onClick: () => show({ tone: "success", title: "Project restored" }) },
        }),
    },
  ];

  return (
    <div className="flex flex-wrap justify-center gap-2">
      {actions.map(({ label, run }) => (
        <button
          key={label}
          type="button"
          onClick={run}
          className="h-12 cursor-pointer border border-ink px-5 font-mono text-xs tracking-[0.1em] uppercase hover:bg-ink hover:text-paper"
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default function Demo() {
  return (
    <ToastProvider>
      <DemoFrame index="Feedback" title="Toast stack" note="Fire a few. Hover the stack to fan it open and stop the clocks, and swipe one away to dismiss it.">
        <Triggers />
      </DemoFrame>
    </ToastProvider>
  );
}
