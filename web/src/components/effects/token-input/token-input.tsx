"use client";

import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type TokenInputProps = {
  value: string[];
  onChange: (value: string[]) => void;
  label: string;
  placeholder?: string;
  /** Offered as you type. */
  suggestions?: readonly string[];
  className?: string;
};

const SPRING = { type: "spring", stiffness: 520, damping: 30 } as const;

/** A tag field. Words snap into tokens on Enter or comma, Backspace takes one back, and suggestions filter live. */
export function TokenInput({ value, onChange, label, placeholder = "Type and press Enter", suggestions = [], className }: TokenInputProps) {
  const [draft, setDraft] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const listId = useId();

  const query = draft.trim().toLowerCase();
  const options = query
    ? suggestions.filter((item) => item.toLowerCase().includes(query) && !value.includes(item)).slice(0, 5)
    : [];

  function add(token: string) {
    const clean = token.trim();
    if (clean && !value.includes(clean)) onChange([...value, clean]);
    setDraft("");
    setHighlight(0);
  }

  return (
    <div className={cn("w-full max-w-xl", className)}>
      <label htmlFor={fieldId} className="mb-2 block font-mono text-[11px] tracking-[0.12em] uppercase">
        {label}
      </label>
      <div
        className="flex min-h-16 flex-wrap items-center gap-2 border border-ink bg-paper-raised p-3 focus-within:outline-2 focus-within:outline-vermilion"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {value.map((token) => (
            <motion.span
              key={token}
              layout
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.6, opacity: 0 }}
              transition={SPRING}
              className="flex items-center gap-2 bg-ink px-3 py-1.5 font-mono text-xs text-paper"
            >
              {token}
              <button
                type="button"
                aria-label={`Remove ${token}`}
                onClick={() => onChange(value.filter((item) => item !== token))}
                className="cursor-pointer opacity-60 hover:opacity-100"
              >
                <X className="size-3" />
              </button>
            </motion.span>
          ))}
        </AnimatePresence>
        <motion.input
          layout="position"
          ref={inputRef}
          id={fieldId}
          value={draft}
          placeholder={value.length ? "" : placeholder}
          autoComplete="off"
          role="combobox"
          aria-expanded={options.length > 0}
          aria-controls={listId}
          onChange={(event) => {
            const next = event.target.value;
            if (next.endsWith(",")) add(next.slice(0, -1));
            else {
              setDraft(next);
              setHighlight(0);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add(options[highlight] ?? draft);
            }
            if (event.key === "Backspace" && !draft) onChange(value.slice(0, -1));
            if (event.key === "ArrowDown" && options.length) {
              event.preventDefault();
              setHighlight((current) => (current + 1) % options.length);
            }
            if (event.key === "ArrowUp" && options.length) {
              event.preventDefault();
              setHighlight((current) => (current - 1 + options.length) % options.length);
            }
          }}
          className="min-w-32 flex-1 bg-transparent outline-none placeholder:text-ink/35"
        />
      </div>
      <ul id={listId} role="listbox" aria-label="Suggestions" className="mt-1">
        {options.map((option, index) => (
          <li key={option} role="option" aria-selected={index === highlight}>
            <button
              type="button"
              onPointerDown={(event) => {
                event.preventDefault();
                add(option);
              }}
              className={cn(
                "flex w-full cursor-pointer justify-between border-b border-rule px-3 py-2 text-left text-sm",
                index === highlight && "bg-paper-sunk",
              )}
            >
              {option}
              <span className="font-mono text-[11px] text-ink-muted">{index === highlight ? "Enter" : ""}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
