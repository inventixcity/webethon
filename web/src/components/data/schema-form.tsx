"use client";
// String fields with format "uri-reference" (or "uri") and x-widget "file" render the uploader and store the
// uploaded file URL. Use "uri-reference": the URL is relative (/api/v1/files/<id>/content), which "uri" rejects.
import { FileDrop } from "./file-drop";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { FieldError } from "@/components/feedback/field-error";
import { useToast } from "@/components/feedback/toaster";
import type { Entity, FieldSchema } from "@/features/data/client";
import { staleReloadOptions } from "@/features/account/errors";
import { formFailure, limitView } from "@/features/data/errors";
import { Button } from "@/components/ui/button";

export const humanize = (name: string) =>
  name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
const typeOf = (field: FieldSchema) =>
  Array.isArray(field.type) ? field.type.find((type) => type !== "null") : field.type;
const nullable = (field: FieldSchema) => Array.isArray(field.type) && field.type.includes("null");
const inputClass = "w-full min-w-0 border border-ink bg-paper-raised px-3 py-2 text-ink outline-offset-2";
const labelClass = "font-mono text-xs uppercase tracking-widest";
function fieldValidator(field: FieldSchema): z.ZodType {
  const type = typeOf(field);
  let validator: z.ZodType;
  if (type === "string") {
    let value = z.string();
    if (field.maxLength !== undefined) value = value.max(field.maxLength);
    if (field.minLength !== undefined) value = value.min(field.minLength);
    validator = value;
  } else if (type === "number" || type === "integer") {
    let value = z.number();
    if (type === "integer") value = value.int();
    if (field.minimum !== undefined) value = value.min(field.minimum);
    if (field.maximum !== undefined) value = value.max(field.maximum);
    validator = value;
  } else if (type === "boolean") validator = z.boolean();
  else if (type === "array") {
    let value = z.array(z.string());
    if (field.maxItems !== undefined) value = value.max(field.maxItems);
    validator = value;
  } else validator = z.unknown();
  if (field.enum) {
    const choices = field.enum;
    validator = validator.refine((value) => choices.includes(value as never), "Choose a valid option.");
  }
  return nullable(field) ? validator.nullable() : validator;
}
function localDate(value: unknown) {
  if (typeof value !== "string" || !value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
function isoWithOffset(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.length === 16 ? `${value}:00` : value}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
type Issue = z.ZodError["issues"][number];

/** A plain sentence for a client-side check. Zod's own wording is not shown to people. */
function plainIssue(issue: Issue, field: FieldSchema): string {
  if (field.enum) return "Choose a valid option.";
  const bound = issue as { minimum?: unknown; maximum?: unknown; origin?: unknown };
  const text = issue.code === "too_small" || issue.code === "too_big" ? String(bound.origin ?? "") : "";
  const isText = text === "string";
  if (issue.code === "too_small") {
    return isText ? `Use at least ${String(bound.minimum)} characters.` : `Enter ${String(bound.minimum)} or more.`;
  }
  if (issue.code === "too_big") {
    return isText ? `Use ${String(bound.maximum)} characters or fewer.` : `Enter ${String(bound.maximum)} or less.`;
  }
  if (issue.code === "invalid_type") return "Enter a valid value.";
  return "Check this value.";
}
export function SchemaForm({
  entity,
  initial,
  onSave,
  onCancel,
}: {
  entity: Entity;
  initial?: Record<string, unknown>;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const fields = entity.schema.properties ?? {};
  const required = entity.schema.required ?? [];
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const result: Record<string, unknown> = { ...initial };
    for (const [name, field] of Object.entries(fields))
      if (!(name in result) && field.default !== undefined) result[name] = field.default;
    return result;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const [tags, setTags] = useState<Record<string, string>>({});
  const setValue = (name: string, value: unknown) => {
    setValues((old) => ({ ...old, [name]: value }));
    setErrors((old) => {
      const next = { ...old };
      delete next[name];
      return next;
    });
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    const shape: Record<string, z.ZodType> = {};
    for (const [name, field] of Object.entries(fields)) {
      const validator = fieldValidator(field);
      shape[name] = required.includes(name) ? validator : validator.optional();
    }
    const result = z.object(shape).safeParse(values);
    if (!result.success) {
      const next: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const name = String(issue.path[0] ?? "");
        if (name && !next[name] && fields[name]) next[name] = plainIssue(issue, fields[name]);
      }
      setErrors(next);
      return;
    }
    setBusy(true);
    try {
      await onSave(result.data);
    } catch (error) {
      // A field the server names gets its message inline. Anything else is a toast.
      const failure = formFailure(error, Object.keys(fields));
      setErrors(failure.named);
      if (failure.toast) toast.error(limitView(failure.toast, entity.label.toLowerCase()), staleReloadOptions(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      {Object.entries(fields).map(([name, field]) => {
        const type = typeOf(field);
        const id = `field-${name}`;
        const error = errors[name];
        const description = field.description;
        const described =
          [description && `${id}-description`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
        const common = {
          id,
          "aria-describedby": described,
          "aria-invalid": !!error,
          required: required.includes(name),
          className: inputClass,
        };
        const value = values[name];
        return (
          <div key={name} className="space-y-2">
            <div className="flex justify-between gap-3">
              <label htmlFor={id} className={labelClass}>
                {field.title ?? humanize(name)}
                {required.includes(name) ? " *" : ""}
              </label>
              {nullable(field) && (
                <Button type="button" variant="link" className="overflow-visible" onClick={() => setValue(name, null)}>
                  Clear
                </Button>
              )}
            </div>
            {description && (
              <p id={`${id}-description`} className="text-sm text-ink-muted">
                {description}
              </p>
            )}
            {type === "string" && (field.format === "uri-reference" || field.format === "uri") && field["x-widget"] === "file" ? (
              <div>
                {typeof value === "string" && value && <p className="mb-2 break-all text-sm">{value}</p>}
                <FileDrop onUpload={(file) => setValue(name, file.url)} />
              </div>
            ) : field.enum ? (
              <select
                {...common}
                value={value == null ? "" : String(value)}
                onChange={(event) => {
                  const choice = field.enum?.find((item) => String(item) === event.target.value);
                  setValue(name, choice ?? (nullable(field) ? null : undefined));
                }}
              >
                <option value="">Select an option</option>
                {field.enum
                  .filter((choice) => choice !== null)
                  .map((choice) => (
                    <option key={String(choice)} value={String(choice)}>
                      {String(choice)}
                    </option>
                  ))}
              </select>
            ) : type === "boolean" ? (
              <input
                {...common}
                type="checkbox"
                role="switch"
                className="h-5 w-5 accent-ink"
                checked={value === true}
                onChange={(event) => setValue(name, event.target.checked)}
              />
            ) : type === "array" ? (
              <div>
                <div className="flex flex-wrap gap-2">
                  {Array.isArray(value) &&
                    value.map((tag, index) => (
                      <Button
                        key={`${tag}-${index}`}
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-auto border border-rule px-2 py-1 font-sans text-sm normal-case tracking-normal"
                        onClick={() =>
                          setValue(
                            name,
                            value.filter((_, itemIndex) => itemIndex !== index),
                          )
                        }
                        aria-label={`Remove ${String(tag)}`}
                      >
                        {String(tag)} ×
                      </Button>
                    ))}
                </div>
                <input
                  {...common}
                  value={tags[name] ?? ""}
                  placeholder="Type a tag and press Enter"
                  onChange={(event) => setTags((old) => ({ ...old, [name]: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      const tag = (tags[name] ?? "").trim();
                      if (tag) {
                        setValue(name, [...(Array.isArray(value) ? value : []), tag]);
                        setTags((old) => ({ ...old, [name]: "" }));
                      }
                    }
                  }}
                />
              </div>
            ) : type === "string" && field.maxLength && field.maxLength > 200 && field.format !== "date-time" ? (
              <textarea
                {...common}
                rows={4}
                value={typeof value === "string" ? value : ""}
                maxLength={field.maxLength}
                onChange={(event) => setValue(name, event.target.value)}
              />
            ) : (
              <input
                {...common}
                type={
                  field.format === "date-time"
                    ? "datetime-local"
                    : type === "number" || type === "integer"
                      ? "number"
                      : "text"
                }
                min={field.minimum}
                max={field.maximum}
                step={type === "number" ? "any" : type === "integer" ? 1 : undefined}
                maxLength={field.maxLength}
                value={
                  field.format === "date-time"
                    ? localDate(value)
                    : typeof value === "string" || typeof value === "number"
                      ? value
                      : ""
                }
                onChange={(event) =>
                  setValue(
                    name,
                    event.target.value === ""
                      ? nullable(field)
                        ? null
                        : type === "number" || type === "integer"
                          ? undefined
                          : ""
                      : field.format === "date-time"
                        ? isoWithOffset(event.target.value)
                        : type === "number" || type === "integer"
                          ? Number(event.target.value)
                          : event.target.value,
                  )
                }
              />
            )}
            <FieldError id={`${id}-error`} message={error} />
          </div>
        );
      })}
      <div className="flex flex-wrap gap-3 border-t border-rule pt-5">
        <Button type="submit" loading={busy} disabled={busy}>
          {busy ? "Saving…" : "Save record"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
