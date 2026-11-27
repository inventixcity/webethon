import Link from "next/link";
import { siteConfig } from "@/config/site";
import { Button } from "@/components/ui/button";

const linkClass = "inline-flex min-h-11 w-fit items-center text-sm text-on-fill underline decoration-on-fill/35 underline-offset-4 transition-colors hover:text-on-fill hover:decoration-vermilion focus-visible:outline-2 focus-visible:outline-focus";

export function SiteFooter() {
  return <footer className="relative isolate overflow-hidden border-t border-cobalt/30 bg-ink text-paper before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-[radial-gradient(color-mix(in_srgb,var(--paper)_7%,transparent)_0.7px,transparent_0.7px)] before:bg-size-[8px_8px] before:opacity-20">
    <div className="border-b border-paper/20 px-5 py-8 md:px-8 md:py-10">
      <div className="mx-auto flex max-w-7xl flex-col gap-5 md:flex-row md:items-center md:justify-between">
        <div><p className="font-mono text-[10px] tracking-[0.14em] text-on-fill/80 uppercase">Next exam / Invigil</p><h2 className="mt-2 text-2xl font-medium tracking-tight md:text-3xl">Run your next exam on Invigil.</h2></div>
        <div className="flex flex-wrap gap-3"><Button asChild size="sm"><Link href="/contact">Contact us</Link></Button><Button asChild variant="secondary" size="sm" className="border-on-fill/50 text-on-fill"><Link href="/verify">Verify a result</Link></Button></div>
      </div>
    </div>
    <div className="mx-auto grid max-w-7xl gap-9 px-5 py-9 sm:grid-cols-2 md:grid-cols-4 md:px-8 md:py-12">
      <div className="grid content-start gap-3"><Link href="/" className="flex min-h-11 w-fit items-center gap-3 font-mono text-[11px] tracking-[0.12em] uppercase"><span className="grid size-10 place-items-center bg-paper text-ink">{siteConfig.mark}</span> Inventix Invigil</Link><p className="max-w-[30ch] text-sm leading-relaxed text-on-fill">Secure examinations that keep working when the connection does not.</p></div>
      <nav aria-label="Product links" className="grid content-start gap-2"><h2 className="mb-1 font-mono text-[11px] tracking-[0.12em] text-on-fill uppercase">Product</h2><Link className={linkClass} href="/#method">How it works</Link><Link className={linkClass} href="/login">Sign in</Link></nav>
      <nav aria-label="For institutes" className="grid content-start gap-2"><h2 className="mb-1 font-mono text-[11px] tracking-[0.12em] text-on-fill uppercase">For institutes</h2><Link className={linkClass} href="/contact">Contact us</Link><Link className={linkClass} href="/verify">Verify a result</Link></nav>
      <address className="grid content-start gap-2 not-italic"><h2 className="mb-1 font-mono text-[11px] tracking-[0.12em] text-on-fill uppercase">Contact</h2><a className={linkClass} href={`mailto:${siteConfig.contact.email}`}>{siteConfig.contact.email}</a><p className="text-sm text-on-fill">{siteConfig.contact.address}</p><p className="text-sm text-on-fill">{siteConfig.contact.hours}</p></address>
    </div>
    <div className="flex flex-col gap-2 border-t border-on-fill/25 px-5 py-4 font-mono text-[10px] tracking-[0.1em] text-on-fill uppercase md:flex-row md:items-center md:justify-between md:px-8"><span>© 2026 Inventix Invigil</span><span>Technoverse 5.0 Web-e-Thon · COMSATS University Lahore</span></div>
  </footer>;
}
