"use client";

import { useState } from "react";
import Link from "next/link";
import type { Booking } from "@/features/booking/client";
import { formatInstant } from "@/features/booking/time";
import { useToast } from "@/components/feedback/toaster";
import { describeError } from "@/lib/errors";
import { Button } from "@/components/ui/button";

type Props = {
  bookings: Booking[];
  /** "booker" lists the viewer's own bookings; "owner" lists bookings on a resource they run. */
  mode: "booker" | "owner";
  /** The zone the times are shown in: the viewer's. */
  zone: string;
  /** Whether the list shows upcoming bookings, which are the only ones that can be cancelled. */
  upcoming: boolean;
  onCancel: (booking: Booking) => Promise<void>;
};

function seatsLabel(seats: number): string {
  return seats === 1 ? "1 seat" : `${seats} seats`;
}

/** Bookings with an inline two-step cancel, so nothing is cancelled by a stray click. */
export function BookingList({ bookings, mode, zone, upcoming, onCancel }: Props) {
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  if (bookings.length === 0) {
    return <p className="text-ink-muted">{upcoming ? "Nothing coming up." : "No past bookings yet."}</p>;
  }

  async function cancel(booking: Booking) {
    setBusy(booking.id);
    try {
      await onCancel(booking);
      setAsking(null);
    } catch (caught) {
      toast.error(describeError(caught, { context: "action" }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-4">
      <ul className="grid divide-y divide-rule border-y border-ink">
        {bookings.map((booking) => {
          const cancelled = booking.status === "cancelled";
          const cancellable = upcoming && !cancelled;
          return (
            <li key={booking.id} className="grid gap-3 py-5 sm:grid-cols-[1fr_auto] sm:items-start">
              <div className="grid min-w-0 gap-1">
                <p className="min-w-0 text-lg font-medium break-words">
                  {mode === "booker" ? (
                    <Link href={`/app/booking/${booking.resourceId}`} className="underline underline-offset-4">
                      {booking.resourceName}
                    </Link>
                  ) : (
                    <span>{booking.bookerName || "A guest"}</span>
                  )}
                </p>
                <p className="text-ink-soft">{formatInstant(booking.startsAt, zone)}</p>
                <p className="font-mono text-[11px] tracking-[0.08em] text-ink-muted uppercase">
                  Resource time: {formatInstant(booking.startsAt, booking.resourceTimezone)}
                </p>
                <p className="font-mono text-[11px] tracking-[0.08em] text-ink-muted uppercase">
                  {seatsLabel(booking.seats)} · {cancelled ? "Cancelled" : "Confirmed"}
                </p>
                {booking.note && <p className="mt-1 text-ink-soft break-words whitespace-pre-line">{booking.note}</p>}
              </div>

              {cancellable && (
                <div className="flex flex-wrap items-center gap-3">
                  {asking === booking.id ? (
                    <>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        loading={busy === booking.id}
                        onClick={() => void cancel(booking)}
                      >
                        {busy === booking.id ? "Cancelling…" : "Yes, cancel"}
                      </Button>
                      <Button type="button" variant="secondary" size="sm" onClick={() => setAsking(null)}>
                        Keep it
                      </Button>
                    </>
                  ) : (
                    <Button type="button" variant="secondary" size="sm" onClick={() => setAsking(booking.id)}>
                      {mode === "owner" ? "Cancel booking" : "Cancel"}
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
