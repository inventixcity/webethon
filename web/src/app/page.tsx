import type { Metadata } from "next";
import Link from "next/link";
import { LandingOwl } from "@/components/app-shell/landing-owl";
import { WaveText } from "@/components/effects/wave-text";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Ticker } from "@/components/motion/ticker";
import { Art, artSrc, hasArt } from "@/components/ui/art";
import { Button } from "@/components/ui/button";
import { DriftField } from "@/components/ui/empty-state";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

// Resolved once on the server. Without the file, the metadata simply carries no image.
const ogImage = artSrc("og-image");

export const metadata: Metadata = {
  title: { absolute: "Inventix Invigil: Exams that hold up." },
  description: siteConfig.description,
  openGraph: {
    title: "Inventix Invigil: Exams that hold up.",
    description: siteConfig.description,
    ...(ogImage ? { images: [{ url: ogImage, width: 1200, height: 630, alt: "Inventix Invigil" }] } : {}),
  },
};

const METHOD = [
  {
    step: "01",
    title: "Author",
    text: "Write questions once in the bank, with answer keys, rubrics and topics. Import a sheet with a dry run first.",
  },
  {
    step: "02",
    title: "Run",
    text: "Enrol candidates by email and open a window. Accommodations add minutes, and the server clock runs every deadline.",
  },
  {
    step: "03",
    title: "Monitor",
    text: "Follow progress, answers and connection status live. Send an announcement to everyone in the room at once.",
  },
  {
    step: "04",
    title: "Grade",
    text: "Objective questions mark themselves. Written answers are graded blind, against the rubric, with feedback.",
  },
  {
    step: "05",
    title: "Publish",
    text: "Check the readiness list, then publish. Each candidate gets a result with a code anyone can verify.",
  },
] as const;

const RESILIENCE = [
  {
    title: "A journal that can't be edited",
    text: "Answers written offline go to a hash-chained journal on the device. Each entry commits to the one before it, so a gap, a reorder or an edit breaks the chain and the server refuses it.",
  },
  {
    title: "Time the server signs",
    text: "The server issues short, signed leases that prove an attempt was alive at a moment of server time. A device clock never decides a deadline.",
  },
  {
    title: "Outages verified, not claimed",
    text: "Heartbeats record real connectivity gaps. A gap becomes credited time only when an examiner approves it, and every credit is audited.",
  },
] as const;

const INTEGRITY = [
  {
    title: "Indicators for review, not verdicts",
    text: "Focus changes, fullscreen exits, paste sizes and device changes are shown as indicators. They are never treated as proof on their own.",
  },
  {
    title: "Invisible watermarks",
    text: "Each candidate's copy of the paper carries an invisible, per-attempt mark. If a question leaks, the trace points to the copy it came from.",
  },
  {
    title: "An AI canary",
    text: "A hidden line in the question text that a person never sees. If it turns up in a written answer, that answer is flagged for review.",
  },
  {
    title: "No webcam, no microphone",
    text: "Invigil never asks for your camera or microphone and records no screen. Typing is counted, never logged as text.",
  },
] as const;

const SECURITY = [
  ["Checked on the server", "Every request is authorised in the API against the signed-in role and ownership. Hiding a page is never the protection."],
  ["Answer keys stay put", "Correct answers, rubrics and explanations are never sent to a candidate before results are published."],
  ["Server time only", "Deadlines, leases and submissions use the server clock. Device clocks are informational."],
  ["Strong sign-in", "Passwords are hashed with Argon2id. Sessions live in HttpOnly cookies, and writes are checked against cross-site requests."],
  ["Audited changes", "Examiner and admin actions are written to an audit log, with no answer content and no secrets."],
  ["Signed results", "Every certificate carries an Ed25519 signature, so its authenticity can be checked by anyone."],
] as const;

const ROLES = [
  {
    role: "Admin",
    text: "Creates and suspends accounts, assigns roles, and reads the audit log.",
  },
  {
    role: "Examiner",
    text: "Writes the question bank, builds and runs exams, monitors sessions, grades, and publishes results.",
  },
  {
    role: "Candidate",
    text: "Sees only their own exams and results. Answers are saved as you go, and kept through a dropped connection.",
  },
] as const;

const LIVE = [
  {
    title: "Watch every seat at once",
    text: "Progress, answers and connection status update live for the whole room. One announcement reaches every candidate at the same moment.",
  },
  {
    title: "Results that explain themselves",
    text: "Objective marks are calculated on the server. Written answers are graded against the rubric, and each mark carries feedback the candidate can read.",
  },
] as const;

const NAV = [
  { href: "#method", label: "Method" },
  { href: "#resilience", label: "Resilience" },
  { href: "#integrity", label: "Integrity" },
  { href: "#security", label: "Security" },
  { href: "#roles", label: "Roles" },
  { href: "/verify", label: "Verify" },
] as const;

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-3 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
      <span aria-hidden="true" className="size-1.5 bg-ink" />
      {children}
    </p>
  );
}

/**
 * An editorial figure: a square-cornered frame with a numbered mono caption. Without its file it shows the ASCII
 * field, so the section still moves.
 */
function Figure({
  name,
  alt,
  num,
  caption,
  ratio = "aspect-[4/3]",
  className,
}: {
  name: string;
  alt: string;
  num: string;
  caption: string;
  ratio?: string;
  className?: string;
}) {
  return (
    <figure className={cn("grid gap-3", className)}>
      <Art
        name={name}
        alt={alt}
        sizes="(min-width: 768px) 42vw, 100vw"
        className={cn("w-full border border-ink", ratio)}
        fallback={<DriftField className="size-full" />}
      />
      <figcaption className="flex flex-wrap justify-between gap-x-6 gap-y-1 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
        <span className="text-ink tabular-nums">FIG. {num}</span>
        <span>{caption}</span>
      </figcaption>
    </figure>
  );
}

export default function LandingPage() {
  const paperTexture = artSrc("bg-paper");

  return (
    <div className="min-h-dvh min-w-0 bg-paper text-ink">
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-ink bg-paper px-5 font-mono text-[11px] tracking-[0.14em] uppercase md:px-8">
        <Link href="/" className="flex min-w-0 items-center gap-3">
          <span className="grid size-7 shrink-0 place-items-center bg-ink text-xs font-bold text-paper">
            {siteConfig.mark}
          </span>
          <span className="truncate">Inventix Invigil</span>
        </Link>
        <nav aria-label="Page sections" className="hidden items-center gap-6 lg:flex">
          {NAV.map((item) => (
            <a key={item.href} href={item.href} className="opacity-70 transition-opacity hover:opacity-100">
              {item.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-4">
          <ThemeToggle className="hidden uppercase opacity-70 transition-opacity hover:opacity-100 sm:flex" />
          <Button asChild size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </header>

      <main>
        <WaveText
          eyebrow="Inventix Invigil"
          edition="Secure online examinations"
          headline={"Exams that\nhold up."}
          description="Authoring, live invigilation, grading and publication in one system. It keeps working when the connection doesn't, and it never asks for your camera."
          actionLabel="Sign in"
          actionHref="/login"
          caption="Move the pointer through the water to make a ripple."
          waveHeight={0.46}
          speed={0.9}
          amplitude={120}
          direction="left"
        />

        <figure className="grid gap-3 px-5 pb-16 md:px-8 md:pb-24">
          <Art
            name="hero"
            darkName="hero-dark"
            alt="A sheet of exam answer paper on a desk, with a fountain pen and a vermilion ribbon bookmark"
            priority
            sizes="100vw"
            className="aspect-[4/3] w-full border border-ink md:aspect-[21/9]"
            position="object-right"
            fallback={<DriftField className="size-full" />}
          />
          <figcaption className="flex flex-wrap justify-between gap-x-6 gap-y-1 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
            <span className="text-ink tabular-nums">FIG. 00</span>
            <span>Answer paper, ink and light</span>
          </figcaption>
        </figure>

        <Ticker
          items={["Failure-resilient", "AI-era integrity", "Server time only", "Verifiable results"]}
          className="bg-ink py-3 text-paper"
        />

        <section aria-labelledby="owl-heading" className="grid gap-10 px-5 py-16 md:grid-cols-12 md:px-8 md:py-24">
          <div className="grid content-start gap-6 md:col-span-5">
            <Eyebrow>The room</Eyebrow>
            <h2 id="owl-heading" className="text-[clamp(2.25rem,5vw,4rem)] leading-[0.98] font-medium tracking-[-0.035em]">
              The owl watches the paper, not the candidate.
            </h2>
            <p className="max-w-[46ch] text-base text-ink-soft">
              Invigil keeps watch over the exam itself: the window, the clock, the connection and the integrity signals
              your institution has agreed to. Nothing reads your face.
            </p>
          </div>
          <LandingOwl className="relative h-[52dvh] min-h-80 overflow-hidden border border-rule md:col-span-7 md:h-[68dvh]" />
        </section>

        <section
          id="method"
          aria-labelledby="method-heading"
          className="relative isolate grid gap-12 overflow-hidden border-t border-ink px-5 py-16 md:px-8 md:py-24"
        >
          {hasArt("bg-grid") ? (
            <Art
              name="bg-grid"
              alt=""
              sizes="100vw"
              className="pointer-events-none absolute inset-0 -z-10 opacity-50"
            />
          ) : null}
          <div className="grid gap-5 md:grid-cols-12">
            <div className="md:col-span-12">
              <Eyebrow>01 / Method</Eyebrow>
            </div>
            <h2 id="method-heading" className="text-[clamp(2.5rem,7vw,6rem)] leading-[0.92] font-medium tracking-[-0.04em] md:col-span-10">
              Author. Run. Monitor. Grade. Publish.
            </h2>
          </div>
          <ol className="grid gap-px border-y border-rule md:grid-cols-5">
            {METHOD.map((item) => (
              <li key={item.step} className="grid content-start gap-4 py-7 md:px-5 md:first:pl-0 md:last:pr-0">
                <span className="font-mono text-[11px] tracking-[0.14em] text-ink-muted tabular-nums">{item.step}</span>
                <h3 className="text-2xl font-medium tracking-[-0.02em]">{item.title}</h3>
                <p className="text-sm leading-relaxed text-ink-soft">{item.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="resilience" aria-labelledby="resilience-heading" className="grid gap-12 border-t border-ink bg-paper-raised px-5 py-16 md:px-8 md:py-24">
          <div className="grid gap-12 md:grid-cols-12 md:items-center md:gap-8">
            <div className="grid gap-6 md:col-span-7">
              <div>
                <Eyebrow>02 / Failure-resilient</Eyebrow>
              </div>
              <h2 id="resilience-heading" className="text-[clamp(2.5rem,7vw,6.25rem)] leading-[0.92] font-medium tracking-[-0.045em]">
                Pull the plug. Lose nothing. Gain nothing.
              </h2>
              <p className="max-w-[60ch] text-lg leading-relaxed text-ink-soft">
                A candidate can lose the connection, the battery or the device and keep every answer. Nobody can use the
                outage to buy time either: the deadline keeps running on the server, and it is never paused automatically.
              </p>
            </div>
            <Figure
              name="feature-resilience"
              alt="An unplugged network cable lying in a curve beside a neat stack of index cards"
              num="01"
              caption="Calm. Nothing is broken."
              ratio="aspect-square"
              className="md:col-span-5"
            />
          </div>
          <ul className="grid gap-px border-y border-rule md:grid-cols-3">
            {RESILIENCE.map((item, index) => (
              <li key={item.title} className="grid content-start gap-4 py-8 md:px-6 md:first:pl-0 md:last:pr-0">
                <span className="font-mono text-[11px] tracking-[0.14em] text-ink-muted tabular-nums">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="text-xl font-medium tracking-[-0.01em]">{item.title}</h3>
                <p className="text-sm leading-relaxed text-ink-soft">{item.text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="integrity" aria-labelledby="integrity-heading" className="grid gap-12 border-t border-ink px-5 py-16 md:px-8 md:py-24">
          <div className="grid gap-12 md:grid-cols-12 md:items-center md:gap-8">
            <Figure
              name="feature-integrity"
              alt="A magnifying glass over pale ink hatching, with one hidden dot pattern showing through"
              num="02"
              caption="Faint marks, found on review"
              ratio="aspect-square"
              className="md:col-span-5 md:order-first"
            />
            <div className="grid gap-6 md:col-span-7">
              <div>
                <Eyebrow>03 / AI-era integrity</Eyebrow>
              </div>
              <h2 id="integrity-heading" className="text-[clamp(2.25rem,6vw,5.25rem)] leading-[0.95] font-medium tracking-[-0.04em]">
                Built for a room where AI is in every pocket.
              </h2>
            </div>
          </div>
          <ul className="grid gap-px border-y border-rule sm:grid-cols-2">
            {INTEGRITY.map((item, index) => (
              <li key={item.title} className="grid content-start gap-4 py-8 sm:px-6 sm:odd:pl-0 sm:even:pr-0">
                <span className="font-mono text-[11px] tracking-[0.14em] text-ink-muted tabular-nums">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="text-xl font-medium tracking-[-0.01em]">{item.title}</h3>
                <p className="text-sm leading-relaxed text-ink-soft">{item.text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="live" aria-labelledby="live-heading" className="grid gap-16 border-t border-ink px-5 py-16 md:px-8 md:py-24">
          <div className="grid gap-5 md:grid-cols-12">
            <div className="md:col-span-12">
              <Eyebrow>04 / Live and graded</Eyebrow>
            </div>
            <h2 id="live-heading" className="text-[clamp(2.25rem,6vw,5.25rem)] leading-[0.95] font-medium tracking-[-0.04em] md:col-span-10">
              See the room as it works. Grade without guessing.
            </h2>
          </div>
          <div className="grid gap-12 md:grid-cols-12 md:items-center md:gap-10">
            <Figure
              name="feature-monitoring"
              alt="A grid of square cards, most with a dim status dot and a few marked for attention"
              num="03"
              caption="The room, live"
              ratio="aspect-[16/10]"
              className="md:col-span-7"
            />
            <div className="grid content-start gap-4 md:col-span-5">
              <h3 className="text-2xl font-medium tracking-[-0.02em]">{LIVE[0].title}</h3>
              <p className="text-base leading-relaxed text-ink-soft">{LIVE[0].text}</p>
            </div>
          </div>
          <div className="grid gap-12 md:grid-cols-12 md:items-center md:gap-10">
            <div className="grid content-start gap-4 md:col-span-5">
              <h3 className="text-2xl font-medium tracking-[-0.02em]">{LIVE[1].title}</h3>
              <p className="text-base leading-relaxed text-ink-soft">{LIVE[1].text}</p>
            </div>
            <Figure
              name="feature-analytics"
              alt="Printed bar charts and a histogram in solid ink, with one cobalt and one amber bar"
              num="04"
              caption="Marks, counted and checked"
              ratio="aspect-[16/10]"
              className="md:col-span-7"
            />
          </div>
        </section>

        <section
          id="security"
          aria-labelledby="security-heading"
          className={cn("grid gap-12 border-t border-ink bg-paper px-5 py-16 md:px-8 md:py-24", paperTexture && "bg-texture")}
          style={paperTexture ? { backgroundImage: `url(${paperTexture})` } : undefined}
        >
          <div className="grid gap-5 md:grid-cols-12">
            <div className="md:col-span-12">
              <Eyebrow>05 / Security</Eyebrow>
            </div>
            <h2 id="security-heading" className="text-[clamp(2.25rem,5.5vw,4.5rem)] leading-[0.95] font-medium tracking-[-0.04em] md:col-span-9">
              Secure by default, checked on the server.
            </h2>
          </div>
          <dl className="grid gap-px border-y border-rule sm:grid-cols-2 lg:grid-cols-3">
            {SECURITY.map(([term, detail]) => (
              <div key={term} className="grid content-start gap-3 py-7 sm:px-6 sm:odd:pl-0 lg:first:pl-0 lg:last:pr-0">
                <dt className="text-lg font-medium tracking-[-0.01em]">{term}</dt>
                <dd className="text-sm leading-relaxed text-ink-soft">{detail}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section id="roles" aria-labelledby="roles-heading" className="grid gap-12 border-t border-ink px-5 py-16 md:px-8 md:py-24">
          <div className="grid gap-5 md:grid-cols-12">
            <div className="md:col-span-12">
              <Eyebrow>06 / Roles</Eyebrow>
            </div>
            <h2 id="roles-heading" className="text-[clamp(2.25rem,5.5vw,4.5rem)] leading-[0.95] font-medium tracking-[-0.04em] md:col-span-9">
              Three roles. Each sees only its own work.
            </h2>
          </div>
          <ul className="grid gap-px border-y border-rule md:grid-cols-3">
            {ROLES.map((item) => (
              <li key={item.role} className="grid content-start gap-3 py-8 md:px-6 md:first:pl-0 md:last:pr-0">
                <h3 className="font-mono text-[11px] tracking-[0.14em] uppercase">{item.role}</h3>
                <p className="text-base leading-relaxed text-ink-soft">{item.text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="verify-heading" className="grid gap-8 border-t border-ink px-5 py-16 md:grid-cols-12 md:items-end md:px-8 md:py-24">
          <div className="grid gap-5 md:col-span-7">
            <Eyebrow>07 / Verify a result</Eyebrow>
            <h2 id="verify-heading" className="text-[clamp(2.25rem,5vw,4rem)] leading-[0.98] font-medium tracking-[-0.035em]">
              Check a result with its code.
            </h2>
            <p className="max-w-[46ch] text-base text-ink-soft">
              Anyone holding a verification code can confirm an exam result is genuine. No account is needed, and only
              the minimum facts are shown.
            </p>
          </div>
          <div className="grid gap-5 md:col-span-5 md:justify-self-end">
            <Figure
              name="feature-verify"
              alt="A certificate card with a square code grid and a vermilion wax seal"
              num="05"
              caption="Signed, and checkable"
              ratio="aspect-[16/10]"
            />
            <div className="md:justify-self-end">
              <Button asChild variant="secondary" size="lg">
                <Link href="/verify">Verify a result</Link>
              </Button>
            </div>
          </div>
        </section>

        <section aria-labelledby="signin-heading" className="grid gap-8 border-t border-ink bg-paper px-5 py-16 text-ink md:px-8 md:py-24" data-theme="dark">
          <h2 id="signin-heading" className="text-[clamp(2.75rem,8vw,6.5rem)] leading-[0.92] font-medium tracking-[-0.045em]">
            Sign in to your exams.
          </h2>
          <div className="flex flex-wrap items-center gap-6">
            <Button asChild size="lg">
              <Link href="/login">Sign in</Link>
            </Button>
            <p className="font-mono text-[11px] tracking-[0.12em] uppercase opacity-80">
              Accounts are created by your institution.
            </p>
          </div>
        </section>
      </main>

      <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-ink px-5 py-6 font-mono text-[11px] tracking-[0.12em] uppercase md:px-8">
        <span>Inventix Invigil · {siteConfig.tagline}</span>
        <nav aria-label="Footer" className="flex items-center gap-6">
          <Link href="/verify" className="opacity-70 hover:opacity-100">Verify</Link>
          <Link href="/login" className="opacity-70 hover:opacity-100">Sign in</Link>
        </nav>
      </footer>
    </div>
  );
}
