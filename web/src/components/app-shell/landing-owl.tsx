"use client";

import { useState } from "react";
import { AsciiCanvas } from "@/components/ascii/ascii-canvas";
import { OwlScene } from "@/components/ascii/scenes/owl";

/**
 * The owl on the landing page. Its eyes follow the pointer across the section, so the picture answers the reader
 * in real time. Under reduced motion the scene holds its still frame and only redraws on a change.
 */
export function LandingOwl({ className }: { className?: string }) {
  const [owl] = useState(() => new OwlScene());

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    owl.lookAtPointer((event.clientX - (box.left + box.width / 2)) / (box.width / 2));
  }

  return (
    <div onPointerMove={onPointerMove} className={className}>
      <AsciiCanvas scene={owl} cell={14} className="absolute inset-0" />
      <span className="sr-only">An ASCII owl keeps watch over the exam room.</span>
    </div>
  );
}
