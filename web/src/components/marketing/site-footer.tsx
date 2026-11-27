import Link from "next/link";
import { siteConfig } from "@/config/site";
const linkClass = "min-h-8 w-fit text-sm text-paper/75 underline decoration-paper/25 underline-offset-4 transition-colors hover:text-paper hover:decoration-vermilion";
export function SiteFooter() {
 return <footer className="bg-ink text-paper">
  <div className="grid gap-10 px-5 py-12 md:grid-cols-4 md:px-8 md:py-16">
   <div className="grid content-start gap-4"><Link href="/" className="flex w-fit items-center gap-3 font-mono text-[11px] tracking-[0.12em] uppercase"><span className="grid size-7 place-items-center bg-paper text-ink">{siteConfig.mark}</span> Inventix Invigil</Link><p className="max-w-[30ch] text-sm leading-relaxed text-paper/70">Secure examinations that keep working when the connection does not.</p></div>
   <nav aria-label="Product links" className="grid content-start gap-2"><h2 className="mb-2 font-mono text-[11px] tracking-[0.12em] text-paper/50 uppercase">Product</h2><Link className={linkClass} href="/#method">How it works</Link><Link className={linkClass} href="/login">Sign in</Link></nav>
   <nav aria-label="For institutes" className="grid content-start gap-2"><h2 className="mb-2 font-mono text-[11px] tracking-[0.12em] text-paper/50 uppercase">For institutes</h2><Link className={linkClass} href="/contact">Contact us</Link><Link className={linkClass} href="/verify">Verify a result</Link></nav>
   <address className="grid content-start gap-2 not-italic"><h2 className="mb-2 font-mono text-[11px] tracking-[0.12em] text-paper/50 uppercase">Contact</h2><a className={linkClass} href={`mailto:${siteConfig.contact.email}`}>{siteConfig.contact.email}</a><p className="text-sm text-paper/70">{siteConfig.contact.address}</p><p className="text-sm text-paper/50">{siteConfig.contact.hours}</p></address>
  </div><div className="flex flex-col gap-2 border-t border-paper/20 px-5 py-5 font-mono text-[10px] tracking-[0.1em] text-paper/60 uppercase md:flex-row md:items-center md:justify-between md:px-8"><span>© 2026 Inventix Invigil</span><span>Technoverse 5.0 Web-e-Thon · COMSATS University Lahore</span></div>
 </footer>;
}
