"use client";

import type { MouseEvent, ReactNode } from "react";

/**
 * A same-page link that scrolls smoothly to its section. It stays a real anchor (href="#id"), so it works without
 * JavaScript and keeps its semantics. Scrolling does not add a history entry, so Back returns to the page the visitor
 * came from. Under reduced motion the jump is instant.
 */
export function SectionLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = document.getElementById(href.slice(1));
    if (!target) return;
    event.preventDefault();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    // replaceState keeps the hash in the address bar without stacking a history entry. Keep Next's own state.
    window.history.replaceState(window.history.state, "", href);
  }
  return (
    <a href={href} onClick={onClick} className={className}>
      {children}
    </a>
  );
}
