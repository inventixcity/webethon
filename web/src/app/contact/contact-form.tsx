"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/feedback/toaster";

type Fields = { institute: string; contactName: string; email: string; phone: string; role: string; expectedCandidates: string; message: string; website: string };
type Field = keyof Fields;
const empty: Fields = { institute: "", contactName: "", email: "", phone: "", role: "", expectedCandidates: "", message: "", website: "" };
const roles = ["Exam controller", "Faculty", "IT", "Admin", "Other"];
const sizes = [{ label: "<100", count: 75 }, { label: "100–500", count: 300 }, { label: "500–2k", count: 1000 }, { label: "2k+", count: 2500 }];
const prompts = ["Offline exams", "Result verification", "Institute setup"];
const steps = ["Institute & size", "Your details", "Your needs"];

function validateStep(values: Fields, step: number): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  if (step === 0 && (values.institute.trim().length < 2 || values.institute.length > 160)) errors.institute = "Enter 2–160 characters.";
  if (step === 1) {
    if (values.contactName.trim().length < 2 || values.contactName.length > 120) errors.contactName = "Enter 2–120 characters.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email) || values.email.length > 254) errors.email = "Enter a valid email address.";
    if (values.phone && !/^[0-9+\- ]{7,20}$/.test(values.phone)) errors.phone = "Use 7–20 digits, +, - or spaces.";
    if (values.role.length > 80) errors.role = "Use 80 characters or fewer.";
  }
  if (step === 2 && (values.message.trim().length < 10 || values.message.length > 2000)) errors.message = "Enter 10–2,000 characters.";
  return errors;
}

export function ContactForm() {
  const [values, setValues] = useState(empty);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const toast = useToast();
  const set = (key: Field, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };
  const advance = () => {
    const nextErrors = validateStep(values, step);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    if (step < 2) { setStep((current) => current + 1); requestAnimationFrame(() => heading.current?.focus()); }
  };
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (step < 2) { advance(); return; }
    const nextErrors = validateStep(values, step);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setBusy(true);
    try {
      await api<{ received: boolean }>("/contact", { method: "POST", body: { institute: values.institute, contactName: values.contactName, email: values.email, phone: values.phone || undefined, role: values.role || undefined, expectedCandidates: values.expectedCandidates ? Number(values.expectedCandidates) : undefined, message: values.message, website: values.website } });
      setSentTo(values.email);
    } catch (error) { toast.error(error instanceof ApiError ? error.message : "We could not send your request. Please try again."); }
    finally { setBusy(false); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Enter" && step < 2 && (event.target as HTMLElement).tagName !== "TEXTAREA" && (event.target as HTMLElement).tagName !== "BUTTON") {
      event.preventDefault(); advance();
    }
  };
  const field = (key: Field, label: string, type = "text", autoComplete?: string) => <div className="grid content-start gap-1.5" key={key}>
    <Label htmlFor={key}>{label}</Label><Input id={key} name={key} type={type} variant="box" value={values[key]} onChange={(event) => set(key, event.target.value)} autoComplete={autoComplete} aria-invalid={Boolean(errors[key])} aria-describedby={errors[key] ? `${key}-error` : undefined} />
    {errors[key] && <p id={`${key}-error`} className="text-sm text-vermilion-deep" role="alert">{errors[key]}</p>}
  </div>;

  if (sentTo) return <div role="status" className="grid gap-5 border-t border-rule pt-6">
    <div aria-hidden="true" className="grid size-14 place-items-center border border-cobalt text-2xl text-cobalt-deep motion-safe:animate-[fade-in_500ms_ease-out]">✉</div>
    <p className="font-mono text-[11px] tracking-[0.12em] text-cobalt-deep uppercase">Request received</p><h2 className="text-2xl font-medium">Your note is in good hands.</h2>
    <p className="text-sm text-ink-soft">We’ll reply to <strong className="text-ink">{sentTo}</strong> within one working day.</p>
    <div className="grid gap-1 border-l-2 border-cobalt pl-4 text-sm"><span>{values.institute}</span><span className="text-ink-soft">{values.contactName} · {values.role || "Institute enquiry"}</span><span className="line-clamp-2 text-ink-muted">{values.message}</span></div>
    <Button variant="secondary" onClick={() => { setSentTo(""); setValues(empty); setStep(0); }}>Send another request</Button>
  </div>;

  return <div className="grid gap-5">
    <div aria-label={`Step ${step + 1} of 3`} className="grid grid-cols-3 border-b border-rule">
      {steps.map((title, index) => <div key={title} className="grid gap-2 pb-3 pr-2">
        <span className="font-mono text-[10px] tracking-[0.1em] text-ink-muted uppercase">0{index + 1} / 03</span>
        <span className={`h-1 bg-paper-sunk transition-colors duration-(--duration-slow) ${index <= step ? "bg-cobalt" : ""}`} aria-hidden="true" />
        <span className={`text-xs ${index === step ? "text-ink" : "text-ink-muted"}`}>{title}</span>
      </div>)}
    </div>
    <form onSubmit={onSubmit} onKeyDown={onKeyDown} noValidate className="grid gap-5">
      <div className="grid min-h-[210px] content-start gap-4">
        <h2 ref={heading} tabIndex={-1} className="text-xl font-medium tracking-tight focus:outline-none">{steps[step]}</h2>
        {step === 0 && <>
          {field("institute", "Institute name")}
          <fieldset className="grid gap-2"><legend className="font-mono text-[11px] tracking-[0.1em] uppercase">Expected candidates</legend><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{sizes.map(({ label, count }) => <button key={label} type="button" aria-pressed={values.expectedCandidates === String(count)} onClick={() => set("expectedCandidates", String(count))} className={`min-h-11 border px-2 text-sm transition-colors duration-(--duration-fast) focus-visible:outline-2 focus-visible:outline-focus ${values.expectedCandidates === String(count) ? "border-cobalt bg-cobalt text-paper" : "border-rule hover:border-cobalt"}`}>{label}</button>)}</div></fieldset>
        </>}
        {step === 1 && <>
          {field("contactName", "Your name", "text", "name")}
          <fieldset className="grid gap-2"><legend className="font-mono text-[11px] tracking-[0.1em] uppercase">Your role</legend><div className="flex flex-wrap gap-2">{roles.map((role) => <button key={role} type="button" aria-pressed={values.role === role} onClick={() => set("role", role)} className={`min-h-10 border px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-focus ${values.role === role ? "border-cobalt bg-cobalt text-paper" : "border-rule hover:border-cobalt"}`}>{role}</button>)}</div></fieldset>
          <div className="grid gap-4 sm:grid-cols-2">{field("email", "Work email", "email", "email")}{field("phone", "Phone (optional)", "tel", "tel")}</div>
        </>}
        {step === 2 && <>
          <div className="flex flex-wrap gap-2" aria-label="Message starters">{prompts.map((prompt) => <button key={prompt} type="button" onClick={() => set("message", `We’re interested in ${prompt.toLowerCase()}. `)} className="min-h-9 border border-rule px-3 text-xs text-ink-soft transition-colors hover:border-cobalt hover:text-cobalt-deep focus-visible:outline-2 focus-visible:outline-focus">+ {prompt}</button>)}</div>
          <div className="grid gap-1.5"><Label htmlFor="message">What would you like to make possible?</Label><textarea id="message" name="message" rows={3} maxLength={2000} value={values.message} onChange={(event) => set("message", event.target.value)} aria-invalid={Boolean(errors.message)} aria-describedby={errors.message ? "message-error" : "message-count"} className="min-h-24 w-full resize-y border border-rule bg-paper-raised px-3 py-2 text-base text-ink outline-none transition-[border-color] focus:border-cobalt focus-visible:outline-2 focus-visible:outline-focus" />{errors.message ? <p id="message-error" role="alert" className="text-sm text-vermilion-deep">{errors.message}</p> : <p id="message-count" className="text-right font-mono text-[10px] text-ink-muted">{values.message.length} / 2000</p>}</div>
        </>}
      </div>
      <div className="absolute -left-[10000px] h-px w-px overflow-hidden" aria-hidden="true"><label htmlFor="website">Website</label><input id="website" name="website" tabIndex={-1} autoComplete="off" value={values.website} onChange={(event) => set("website", event.target.value)} /></div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-4">
        <Button type="button" variant="ghost" onClick={() => { setStep((current) => Math.max(0, current - 1)); requestAnimationFrame(() => heading.current?.focus()); }} disabled={step === 0 || busy}>Back</Button>
        {step < 2 ? <Button type="submit">Continue <span aria-hidden="true">→</span></Button> : <Button type="submit" loading={busy} aria-busy={busy} disabled={busy}>Send request</Button>}
      </div>
    </form>
    <aside aria-live="polite" className="grid gap-1 border-t border-rule pt-3 text-xs"><span className="font-mono tracking-[0.1em] text-ink-muted uppercase">Your request</span><span className="text-ink">{values.institute || "Institute name"} · {values.expectedCandidates ? `${Number(values.expectedCandidates).toLocaleString()} candidates` : "candidate scale"}</span><span className="text-ink-soft">{values.contactName || "Your name"}{values.role ? ` · ${values.role}` : ""}{values.email ? ` · ${values.email}` : ""}</span><span className="line-clamp-1 text-ink-muted">{values.message || "Your note will appear here as you write."}</span></aside>
  </div>;
}
