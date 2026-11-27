"use client";

import type { ReactNode } from "react";
import type { WorkspacePrefs } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import { Drawer } from "./drawer";

type Option<T extends string | number> = { value: T; label: string };

type PrefsDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefs: WorkspacePrefs;
  onChange: (patch: Partial<WorkspacePrefs>) => void;
};

/** Preferences (4.7). Each change applies at once and is saved in the background. */
export function PrefsDrawer({ open, onOpenChange, prefs, onChange }: PrefsDrawerProps) {
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Preferences"
      description="Saved to your account. Applies to every exam you take here."
    >
      <div className="grid gap-7 p-5">
        <Group name="font-size" legend="Text size">
          <Segmented
            name="font-size"
            label="Text size"
            value={prefs.fontScale}
            onChange={(value) => onChange({ fontScale: value })}
            options={[
              { value: 0.9, label: "90%" },
              { value: 1, label: "100%" },
              { value: 1.15, label: "115%" },
              { value: 1.3, label: "130%" },
            ]}
          />
        </Group>

        <Group name="layout" legend="Question layout">
          <Segmented
            name="layout"
            label="Question layout"
            value={prefs.layout}
            onChange={(value) => onChange({ layout: value })}
            options={[
              { value: "single", label: "One at a time" },
              { value: "scroll", label: "Scroll" },
            ]}
          />
        </Group>

        <Group name="palette-side" legend="Question palette side">
          <Segmented
            name="palette-side"
            label="Question palette side"
            value={prefs.paletteSide}
            onChange={(value) => onChange({ paletteSide: value })}
            options={[
              { value: "left", label: "Left" },
              { value: "right", label: "Right" },
            ]}
          />
        </Group>

        <Group name="contrast" legend="Contrast">
          <Segmented
            name="contrast"
            label="Contrast"
            value={prefs.contrast}
            onChange={(value) => onChange({ contrast: value })}
            options={[
              { value: "normal", label: "Normal" },
              { value: "high", label: "High" },
            ]}
          />
        </Group>

        <Group name="theme" legend="Colour theme">
          <Segmented
            name="theme"
            label="Colour theme"
            value={prefs.theme}
            onChange={(value) => onChange({ theme: value })}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </Group>

        <Group name="timer" legend="Timer">
          <Segmented
            name="timer"
            label="Timer"
            value={prefs.timerStyle}
            onChange={(value) => onChange({ timerStyle: value })}
            options={[
              { value: "countdown", label: "Countdown" },
              { value: "hidden_until_5min", label: "Hidden until 5 min" },
            ]}
          />
        </Group>

        <Group name="spacing" legend="Line spacing">
          <Segmented
            name="spacing"
            label="Line spacing"
            value={prefs.lineSpacing}
            onChange={(value) => onChange({ lineSpacing: value })}
            options={[
              { value: "normal", label: "Normal" },
              { value: "relaxed", label: "Relaxed" },
            ]}
          />
        </Group>

        <p className="font-sans text-sm text-ink-soft">
          Keyboard: Alt+N next question, Alt+P previous question, Alt+F flag the current question.
        </p>
      </div>
    </Drawer>
  );
}

function Group({ name, legend, children }: { name: string; legend: string; children: ReactNode }) {
  return (
    <fieldset data-group={name} className="grid gap-3">
      <legend className="font-mono text-[11px] tracking-[0.14em] uppercase">{legend}</legend>
      {children}
    </fieldset>
  );
}

/** Native radios styled as a segmented control, so arrow keys and screen readers work as usual. */
function Segmented<T extends string | number>({
  name,
  label,
  value,
  options,
  onChange,
}: {
  name: string;
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid grid-flow-col auto-cols-fr border border-ink">
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <label
            key={String(option.value)}
            className={cn(
              "relative flex min-h-12 cursor-pointer items-center justify-center px-2 text-center font-mono text-[11px] tracking-[0.08em] uppercase transition-colors duration-(--duration-fast)",
              index > 0 && "border-l border-ink",
              checked ? "bg-ink text-paper" : "text-ink hover:bg-paper-sunk",
            )}
          >
            <input
              type="radio"
              name={`ws-pref-${name}`}
              value={String(option.value)}
              checked={checked}
              aria-label={`${label}: ${option.label}`}
              onChange={() => onChange(option.value)}
              className="peer sr-only"
            />
            <span className="peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus">
              {option.label}
            </span>
          </label>
        );
      })}
    </div>
  );
}
