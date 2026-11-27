"use client";

import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { setTheme, useTheme } from "./theme";

export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} mode`}
      className={cn("flex cursor-pointer items-center gap-2", className)}
    >
      {theme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
      <span className="hidden sm:inline">{next}</span>
    </button>
  );
}
