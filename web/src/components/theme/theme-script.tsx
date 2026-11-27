"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";

// Runs before the first paint, so a dark-mode visitor never sees a flash of the light page.
const script = `(function(){try{var t=localStorage.getItem("theme");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=t}catch(e){}})()`;

/** The same rule as `script`, for when React renders the page in the browser and the script never runs. */
function applySavedTheme() {
  try {
    let theme = localStorage.getItem("theme");
    if (theme !== "light" && theme !== "dark") theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
  } catch {
    // Storage can be blocked (private windows, some embeds). The CSS default theme stays.
  }
}

const subscribeNever = () => () => {};

/**
 * React builds a <script> on the client as an inert element and logs "Encountered a script tag while rendering
 * React component". Some 404s are like that: Next sends an empty shell and the browser renders the whole root
 * layout. So the script is rendered only while the server HTML hydrates (the server snapshot is true there, and
 * false afterwards). A browser-only render then applies the theme in a layout effect, which runs before paint.
 */
export function ThemeScript() {
  const inServerHtml = useSyncExternalStore(
    subscribeNever,
    () => false,
    () => true,
  );
  useLayoutEffect(applySavedTheme, []);
  return inServerHtml ? <script dangerouslySetInnerHTML={{ __html: script }} /> : null;
}
