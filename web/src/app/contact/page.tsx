import Link from "next/link";
import { Mail, ShieldCheck, Radio, WifiOff } from "lucide-react";
import { ContactForm } from "./contact-form";
import { SiteNav } from "@/components/marketing/site-nav";
import { SiteFooter } from "@/components/marketing/site-footer";
import { siteConfig } from "@/config/site";

export const metadata = { title: "Contact your institute | Inventix Invigil", description: "Ask about bringing Invigil to your institute." };
const proof = [
  { icon: WifiOff, title: "Offline-proof exams", note: "Keep candidates moving through connection loss." },
  { icon: ShieldCheck, title: "Signed, verifiable results", note: "Give every published result a trusted trail." },
  { icon: Radio, title: "Live control room", note: "See the exam as it unfolds." },
];

export default function ContactPage() {
  return <div className="min-h-dvh bg-paper text-ink">
    <SiteNav />
    <main className="mx-auto grid w-full max-w-7xl gap-8 px-5 py-7 md:grid-cols-12 md:gap-12 md:px-8 md:py-10">
      <section className="grid content-start gap-4 md:col-span-5 lg:gap-5">
        <p className="font-mono text-[11px] tracking-[0.12em] text-vermilion-deep uppercase">For institutes / start a conversation</p>
        <h1 className="max-w-[12ch] text-4xl leading-[0.98] font-medium tracking-tight sm:text-5xl lg:text-6xl">Bring Invigil to your institute.</h1>
        <p className="max-w-[43ch] text-sm leading-relaxed text-ink-soft">Tell us what your exam team needs. We’ll help you map a secure, resilient setup for your next session.</p>
        <ul className="grid border-y border-rule" aria-label="What Invigil offers">{proof.map(({ icon: Icon, title, note }, index) => <li key={title} className="group grid grid-cols-[2.25rem_1fr] gap-x-3 border-b border-rule py-3 last:border-0 motion-safe:animate-[fade-in_500ms_ease-out]" style={{ animationDelay: `${index * 100}ms` }}><Icon aria-hidden="true" className="mt-0.5 size-5 text-cobalt-deep transition-transform duration-(--duration-base) group-hover:translate-x-1 motion-reduce:transform-none" /><div><h2 className="text-sm font-medium">{title}</h2><p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{note}</p></div></li>)}</ul>
        <div className="grid gap-2 border-l-2 border-vermilion pl-4"><p className="font-mono text-[11px] tracking-[0.1em] uppercase">A real person, within one working day</p><p className="text-xs text-ink-muted">Monday–Friday, 9:00–17:00 PKT</p></div>
        <a className="flex min-h-10 w-fit items-center gap-2 text-sm text-ink-soft underline decoration-rule underline-offset-4 transition-colors hover:text-cobalt-deep" href={`mailto:${siteConfig.contact.email}`}><Mail aria-hidden="true" className="size-4" />{siteConfig.contact.email}</a>
        <p className="text-xs text-ink-muted">{siteConfig.contact.address} · <Link className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-cobalt-deep" href="/verify">Verify a result</Link></p>
      </section>
      <section aria-label="Institute contact form" className="border border-rule bg-surface-1 p-4 sm:p-6 md:col-span-7 lg:p-7"><ContactForm /></section>
    </main>
    <SiteFooter />
  </div>;
}
