import type { Metadata } from "next";
import Link from "next/link";
import { LandingOwl } from "@/components/app-shell/landing-owl";
import { WaveText } from "@/components/effects/wave-text";
import { MethodSteps } from "@/components/landing/method-steps";
import { Eyebrow, Figure, SectionTitle } from "@/components/landing/primitives";
import { ResilienceCompare } from "@/components/landing/resilience-compare";
import { SecurityCards } from "@/components/landing/security-cards";
import { Art, artSrc } from "@/components/ui/art";
import { Button } from "@/components/ui/button";
import { siteConfig } from "@/config/site";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteNav } from "@/components/marketing/site-nav";

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
  { title: "Author", text: "Write the question bank, with answer keys and rubrics, once." },
  { title: "Run", text: "Enrol candidates by email and open a timed window." },
  { title: "Monitor", text: "Follow progress and connection status, and announce to the room." },
  { title: "Grade", text: "Objective items mark themselves. Written answers are graded blind." },
  { title: "Publish", text: "Check the readiness list, then publish a signed result." },
  { title: "Verify", text: "Anyone with the code confirms a result. No account needed." },
] as const;

const INTEGRITY = [
  {
    title: "Indicators for review, not verdicts",
    text: "Focus changes, fullscreen exits, paste sizes and device changes are shown as indicators. They are never proof on their own.",
  },
  {
    title: "Invisible watermarks",
    text: "Each candidate's copy carries an invisible, per-attempt mark. If a question leaks, the trace points to the copy it came from.",
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

const COLLECTS = [
  "Focus changes, shown as indicators",
  "Fullscreen exits",
  "Paste sizes",
  "Device and connection changes",
  "Heartbeat timing, for outage credit",
  "Answers, kept for the candidate and the examiner",
] as const;

const NEVER_COLLECTS = [
  "Camera or microphone",
  "Screen recordings",
  "Typed text, as keystrokes",
  "Face, eye or voice data",
  "Answer keys, before results are published",
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

const ROLES = [
  { role: "Admin", text: "Creates and suspends accounts, assigns roles, and reads the audit log." },
  {
    role: "Examiner",
    text: "Writes the question bank, builds and runs exams, monitors sessions, grades, and publishes results.",
  },
  {
    role: "Candidate",
    text: "Sees only their own exams and results. Answers are saved as you go, and kept through a dropped connection.",
  },
] as const;

const SECTION = "grid gap-12 border-t border-ink px-5 py-16 md:px-8 md:py-24";
const NOTE = "font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase";
// Each list row of the collected / never-collected panel: a hover tint and a 2px cobalt bar on the left.
const LIST_ROW =
  "relative border-t border-rule py-3 pl-4 text-base leading-snug transition-colors duration-200 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-cobalt before:scale-y-0 before:transition-transform before:duration-200 hover:bg-paper-sunk hover:before:scale-y-100 dark:hover:bg-surface-2 motion-reduce:before:transition-none";

export default function LandingPage() {
  return (
    <div className="min-h-dvh min-w-0 bg-paper text-ink">
      <SiteNav />

      <main>
        {/* The opening statement: the animated water and the headline, with the hero figure and the actions
            composed into the same first screen. */}
        <div className="relative">
          <WaveText
            eyebrow="Inventix Invigil"
            edition="Secure online examinations"
            headline={"Exams that\nhold up."}
            description="Authoring, live invigilation, grading and publication in one system. It keeps working when the connection doesn't, and it never asks for your camera."
            actionLabel=""
            caption="Move the pointer through the water to make a ripple."
            waveHeight={0.46}
            speed={0.9}
            amplitude={120}
            direction="left"
          />
          {/* Hero figure: a slightly tilted answer sheet on a small stack of offset frames (cobalt, amber), sealed
              with a vermilion figure stamp. Sized explicitly, so it can never collapse. */}
          <figure className="pointer-events-none absolute top-[14%] right-[5vw] z-10 hidden w-[min(28vw,440px)] lg:block">
            <div className="relative -rotate-2">
              <div aria-hidden="true" className="absolute inset-0 translate-x-6 translate-y-6 border border-amber" />
              <div aria-hidden="true" className="absolute inset-0 translate-x-3 translate-y-3 border border-cobalt bg-paper-sunk" />
              <Art
                name="hero"
                darkName="hero-dark"
                alt="A sheet of exam answer paper on a desk, with a fountain pen and a vermilion ribbon bookmark"
                sizes="(min-width: 1024px) 28vw, 90vw"
                priority
                position="object-[22%_50%]"
                className="grain h-[min(44vh,480px)] w-full border border-ink bg-paper"
              />
              <span
                aria-hidden="true"
                className="absolute -top-5 -left-5 grid size-16 place-items-center bg-vermilion-deep font-mono text-[11px] tracking-[0.14em] text-paper uppercase"
                data-theme="light"
              >
                Fig. 00
              </span>
            </div>
            <figcaption className="sr-only">Figure 00: answer paper, ink and light.</figcaption>
          </figure>
          {/* Actions sit on the water, which is always the inverse of the page colour, so they use the inverse
              buttons: cream on ink in light mode, ink on cream in dark mode. */}
          <div className="absolute bottom-[17%] left-5 z-10 flex flex-wrap items-center gap-4 md:left-8">
            <Button asChild variant="inverse" size="lg">
              <Link href="/login">Sign in</Link>
            </Button>
            <Button asChild variant="outline-inverse" size="lg">
              <Link href="/verify">Verify a result</Link>
            </Button>
          </div>
        </div>

        <section
          id="start"
          aria-label="At a glance"
          className="grid gap-8 border-b border-rule px-5 py-12 md:grid-cols-12 md:items-end md:px-8 md:py-16"
        >
          <p className="max-w-[34ch] text-[clamp(1.6rem,3vw,2.4rem)] leading-[1.1] font-medium tracking-[-0.025em] md:col-span-7">
            Run an exam, watch the room and publish results that anyone can check.
          </p>
          <ul className="grid gap-px border border-rule bg-rule font-mono text-[11px] tracking-[0.12em] uppercase md:col-span-5 md:grid-cols-3">
            <li className="grid gap-2 bg-paper p-4"><span className="text-cobalt-deep">01</span>Server time only</li>
            <li className="grid gap-2 bg-paper p-4"><span className="text-cobalt-deep">02</span>Answers kept offline</li>
            <li className="grid gap-2 bg-paper p-4"><span className="text-amber-deep">03</span>No webcam</li>
          </ul>
        </section>

        <section className="grid gap-10 px-5 py-14 md:hidden">
          <Figure
            name="hero"
            darkName="hero-dark"
            alt="A sheet of exam answer paper on a desk, with a fountain pen and a vermilion ribbon bookmark"
            num="00"
            caption="Answer paper, ink and light"
            sizes="90vw"
          />
        </section>

        <section aria-label="The room" className="grid gap-10 px-5 py-16 md:grid-cols-12 md:items-center md:px-8 md:py-24">
          <div className="grid content-start gap-6 md:col-span-5">
            <Eyebrow>The room</Eyebrow>
            <h2 className="text-[clamp(2.25rem,4.6vw,4rem)] leading-[0.98] font-medium tracking-[-0.035em]">
              The owl watches the paper, not the candidate.
            </h2>
            <p className="max-w-[46ch] text-base text-ink-soft">
              Invigil keeps watch over the exam itself: the window, the clock, the connection and the integrity signals your
              institution has agreed to. Nothing reads your face.
            </p>
          </div>
          <LandingOwl className="relative h-[46dvh] min-h-72 overflow-hidden border border-rule md:col-span-7 md:h-[52dvh]" />
        </section>

        <section id="method" aria-labelledby="method-heading" className={SECTION}>
          <SectionTitle id="method-heading" num="01" label="Method">
            Author. Run. Monitor. Grade. Publish. Verify.
          </SectionTitle>
          <MethodSteps steps={METHOD} />
        </section>

        <section id="resilience" aria-labelledby="resilience-heading" className={SECTION}>
          <div className="grid gap-8 md:grid-cols-12 md:items-end">
            <SectionTitle id="resilience-heading" num="02" label="Failure-resilient" className="md:col-span-12">
              Pull the plug. Lose nothing. Gain nothing.
            </SectionTitle>
            <p className="max-w-[60ch] text-lg leading-relaxed text-ink-soft md:col-span-7">
              A candidate can lose the connection, the battery or the device and keep every answer. Nobody can use an outage to
              buy time either: the deadline keeps running on the server, and it is never paused on its own.
            </p>
          </div>
          <div className="grid gap-10 md:grid-cols-12 md:items-start">
            <Figure
              name="feature-resilience"
              alt="An unplugged network cable lying in a curve beside a neat stack of index cards"
              num="01"
              caption="Calm. Nothing is broken."
              className="md:col-span-5"
            />
            <div className="md:col-span-7">
              <ResilienceCompare />
            </div>
          </div>
        </section>

        <section id="integrity" aria-labelledby="integrity-heading" className={SECTION}>
          <div className="grid gap-12 md:grid-cols-12 md:items-start md:gap-8">
            <Figure
              name="feature-integrity"
              alt="A magnifying glass over pale ink hatching, with one hidden dot pattern showing through"
              num="02"
              caption="Faint marks, found on review"
              className="md:sticky md:top-24 md:col-span-5"
            />
            <div className="grid content-start gap-8 md:col-span-6 md:col-start-7">
              <SectionTitle id="integrity-heading" num="03" label="AI-era integrity">
                Built for a room where AI is in every pocket.
              </SectionTitle>
              <ol className="grid border-y border-rule">
                {INTEGRITY.map((item, index) => (
                  <li key={item.title} className="grid grid-cols-[2.5rem_1fr] gap-x-2 border-b border-rule py-6 last:border-b-0">
                    <span className="font-mono text-[11px] tracking-[0.14em] text-ink-muted tabular-nums">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div className="grid gap-2">
                      <h3 className="text-xl font-medium tracking-[-0.01em]">{item.title}</h3>
                      <p className="text-sm leading-relaxed text-ink-soft">{item.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          <div className="grid gap-5">
            <Eyebrow>What is collected, and what is not</Eyebrow>
            <div className="grid gap-px border border-rule bg-rule md:grid-cols-2">
              <div className="grid content-start gap-4 bg-paper p-6 md:p-8">
                <h3 className="font-mono text-[11px] tracking-[0.14em] uppercase">Collected</h3>
                <ul className="grid">
                  {COLLECTS.map((item) => (
                    <li key={item} className={LIST_ROW}>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="grid content-start gap-4 bg-paper p-6 md:p-8">
                <h3 className="font-mono text-[11px] tracking-[0.14em] uppercase">Never collected</h3>
                <ul className="grid">
                  {NEVER_COLLECTS.map((item) => (
                    <li key={item} className={LIST_ROW}>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section id="live" aria-labelledby="live-heading" className="grid gap-16 border-t border-ink px-5 py-16 md:px-8 md:py-24">
          <SectionTitle id="live-heading" num="04" label="Live and graded">
            See the room as it works. Grade without guessing.
          </SectionTitle>

          <div className="grid gap-16">
            <div className="grid gap-10 md:grid-cols-12 md:items-center md:gap-10">
              <Figure
                name="feature-monitoring"
                alt="A grid of square cards, most with a dim status dot and a few marked for attention"
                num="03"
                caption="The room, live"
                className="md:col-span-6"
              />
              <div className="grid content-center gap-4 md:col-span-5 md:col-start-8">
                <h3 className="text-2xl font-medium tracking-[-0.02em]">{LIVE[0].title}</h3>
                <p className="max-w-[46ch] text-base leading-relaxed text-ink-soft">{LIVE[0].text}</p>
              </div>
            </div>
            <div className="grid gap-10 md:grid-cols-12 md:items-center md:gap-10">
              <div className="grid content-center gap-4 md:col-span-5 md:col-start-1 md:row-start-1">
                <h3 className="text-2xl font-medium tracking-[-0.02em]">{LIVE[1].title}</h3>
                <p className="max-w-[46ch] text-base leading-relaxed text-ink-soft">{LIVE[1].text}</p>
              </div>
              <Figure
                name="feature-analytics"
                alt="Printed bar charts and a histogram in solid ink, with one cobalt and one amber bar"
                num="04"
                caption="Marks, counted and checked"
                className="md:col-span-6 md:col-start-7 md:row-start-1"
              />
            </div>
          </div>
        </section>

        <section
          id="security"
          aria-labelledby="security-heading"
          className="grid gap-12 border-t border-ink bg-paper-raised px-5 py-16 md:px-8 md:py-24"
        >
          <SectionTitle id="security-heading" num="05" label="Security">
            Secure by default, checked on the server.
          </SectionTitle>
          <p className="max-w-[60ch] text-lg leading-relaxed text-ink-soft">
            Every control below runs in the API or the database, never only in the page. Hiding a screen is not the protection.
          </p>
          <SecurityCards />
        </section>

        <section id="roles" aria-labelledby="roles-heading" className={SECTION}>
          <SectionTitle id="roles-heading" num="06" label="Roles">
            Three roles. Each sees only its own work.
          </SectionTitle>
          <ul className="grid gap-px border-y border-rule bg-rule md:grid-cols-3">
            {ROLES.map((item, index) => (
              <li key={item.role} className="grid content-start gap-4 bg-paper py-8 md:px-6 md:first:pl-0 md:last:pr-0">
                <span className="font-mono text-[11px] tracking-[0.14em] text-ink-muted tabular-nums">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="text-4xl leading-none font-medium tracking-[-0.03em]">{item.role}</h3>
                <p className="text-base leading-relaxed text-ink-soft">{item.text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="verify-heading" className="grid gap-12 border-t border-ink px-5 py-16 md:grid-cols-12 md:items-center md:px-8 md:py-24">
          <div className="grid content-start gap-6 md:col-span-6">
            <Eyebrow num="07">Verify a result</Eyebrow>
            <h2 id="verify-heading" className="text-[clamp(2.5rem,5.4vw,4.5rem)] leading-[0.96] font-medium tracking-[-0.04em]">
              Check a result with its code.
            </h2>
            <p className="max-w-[46ch] text-base leading-relaxed text-ink-soft">
              Anyone holding a verification code can confirm an exam result is genuine. No account is needed, and only the minimum
              facts are shown.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <Button asChild size="lg">
                <Link href="/verify">Verify a result</Link>
              </Button>
            </div>
          </div>
          <Figure
            name="feature-verify"
            alt="A certificate card with a square code grid and a vermilion wax seal"
            num="05"
            caption="Signed, and checkable"
            ratio="aspect-[4/3]"
            className="md:col-span-5 md:col-start-8"
          />
        </section>

        <section aria-labelledby="contact-heading" className="grid gap-6 border-t border-ink bg-paper-raised px-5 py-14 md:grid-cols-12 md:items-center md:px-8 md:py-20">
          <div className="grid gap-3 md:col-span-8"><p className={NOTE}>For institutes</p><h2 id="contact-heading" className="text-3xl font-medium tracking-tight md:text-5xl">Bring Invigil to your institute.</h2><p className="max-w-[50ch] text-base text-ink-soft">Tell us about your exam programme and our team will help you get started.</p></div><Button asChild size="lg"><Link href="/contact">Contact us</Link></Button>
        </section>

        <section aria-labelledby="signin-heading" className="grid gap-8 border-t border-ink bg-paper-sunk px-5 py-20 md:px-8 md:py-28">
          <h2 id="signin-heading" className="max-w-[18ch] text-[clamp(3rem,8vw,6.5rem)] leading-[0.92] font-medium tracking-[-0.045em]">
            Sign in to your exams.
          </h2>
          <p className="max-w-[52ch] text-lg leading-relaxed text-ink-soft">
            Open your examiner or candidate workspace with the account your institution gave you.
          </p>
          <div className="flex flex-wrap items-center gap-6">
            <Button asChild size="lg">
              <Link href="/login">Sign in</Link>
            </Button>
            <p className={NOTE}>Accounts are created by your institution.</p>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

