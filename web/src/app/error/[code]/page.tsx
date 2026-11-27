import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ErrorPage } from "@/components/errors/error-page";
import { ERROR_PAGE_CODES, type ErrorPageCode } from "@/lib/errors/types";

/** Preview only. Linked from the error index, never from the product. */

export const metadata: Metadata = { title: "Error pages" };

// Any code outside ERROR_PAGE_CODES is a 404 at the routing layer. Left to the page, the notFound()
// signal arrives after the stream has started and the response is a 200 with no 404 page.
export const dynamicParams = false;

type Props = { params: Promise<{ code: string }> };

/** Sample values, so the preview shows the request id and the countdown. */
const SAMPLE_REQUEST_ID = "req_preview_0a1b2c3d4e";
const SAMPLE_RETRY_SECONDS = 30;

export function generateStaticParams() {
  return ERROR_PAGE_CODES.map((code) => ({ code: String(code) }));
}

function findCode(value: string): ErrorPageCode | undefined {
  return ERROR_PAGE_CODES.find((code) => String(code) === value);
}

export default async function ErrorPreview({ params }: Props) {
  const { code } = await params;
  const match = findCode(code);
  if (match === undefined) notFound();

  return (
    <>
      <ErrorPage
        code={match}
        requestId={SAMPLE_REQUEST_ID}
        retryAfterSeconds={match === 429 ? SAMPLE_RETRY_SECONDS : undefined}
      />
      <nav aria-label="Error page previews" className="border-t border-ink bg-paper px-5 py-8 md:px-8">
        <p className="mb-4 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">All error pages</p>
        <ul className="flex flex-wrap gap-2">
          {ERROR_PAGE_CODES.map((item) => (
            <li key={item}>
              <Link
                href={`/error/${item}`}
                prefetch={false}
                aria-current={item === match ? "page" : undefined}
                className={
                  item === match
                    ? "inline-block bg-ink px-3 py-2 font-mono text-[11px] tracking-[0.1em] text-paper uppercase"
                    : "inline-block border border-ink px-3 py-2 font-mono text-[11px] tracking-[0.1em] text-ink uppercase transition-colors hover:bg-ink hover:text-paper"
                }
              >
                {item}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
